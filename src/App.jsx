import { useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import './App.css'

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const initialMessage = {
  id: 1,
  role: 'assistant',
  content: 'Upload a PDF and ask me anything about it. I will search the document locally and answer from the most relevant passages.',
}

function chunkTextByWords(text, wordsPerChunk = 90) {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks = []

  for (let index = 0; index < words.length; index += wordsPerChunk) {
    const segment = words.slice(index, index + wordsPerChunk).join(' ')
    if (segment) {
      chunks.push(segment)
    }
  }

  return chunks
}

function buildChunks(pages) {
  const chunks = []

  pages.forEach((page) => {
    const pageChunks = chunkTextByWords(page.text)
    pageChunks.forEach((segment, index) => {
      chunks.push({
        id: `${page.page}-${index}`,
        page: page.page,
        text: segment,
      })
    })
  })

  return chunks
}

function getRelevantChunks(query, chunks) {
  const normalizedQuery = query.toLowerCase()
  const queryTerms = normalizedQuery.split(/\W+/).filter(Boolean)

  if (!queryTerms.length || chunks.length === 0) {
    return []
  }

  return chunks
    .map((chunk) => {
      const normalizedText = chunk.text.toLowerCase()
      let score = 0

      queryTerms.forEach((term) => {
        const matches = normalizedText.match(new RegExp(term, 'g')) || []
        if (matches.length) {
          score += matches.length * 3
        }
      })

      if (normalizedText.includes(normalizedQuery)) {
        score += 12
      }

      if (queryTerms.some((term) => normalizedText.includes(term))) {
        score += 2
      }

      return { ...chunk, score }
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
}

function renderMessageContent(content) {
  const blocks = content.split(/\n{2,}/).filter(Boolean)

  return blocks.map((block, index) => {
    const lines = block.split('\n').filter(Boolean)

    if (lines.every((line) => line.trim().startsWith('- '))) {
      return (
        <ul key={`${block}-${index}`} className="message-bullets">
          {lines.map((line, lineIndex) => (
            <li key={`${line}-${lineIndex}`}>{line.replace(/^- /, '').trim()}</li>
          ))}
        </ul>
      )
    }

    return (
      <p key={`${block}-${index}`} className="message-paragraph">
        {lines.map((line, lineIndex) => (
          <span key={`${line}-${lineIndex}`}>
            {lineIndex > 0 ? <br /> : null}
            {line}
          </span>
        ))}
      </p>
    )
  })
}

function App() {
  const [messages, setMessages] = useState([initialMessage])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedFileName, setUploadedFileName] = useState('')
  const [documentTitle, setDocumentTitle] = useState('No PDF uploaded yet')
  const [chunks, setChunks] = useState([])
  const [status, setStatus] = useState('Upload a PDF to start')
  const [dragActive, setDragActive] = useState(false)

  const hasPdf = chunks.length > 0

  const handleFile = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setStatus('Please choose a valid PDF file.')
      return
    }

    setIsLoading(true)
    setStatus(`Reading ${file.name}...`)

    try {
      const arrayBuffer = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const pages = []

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        const pageText = content.items
          .map((item) => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (pageText) {
          pages.push({ page: pageNumber, text: pageText })
        }
      }

      const nextChunks = buildChunks(pages)
      setChunks(nextChunks)
      setUploadedFileName(file.name)
      setDocumentTitle(file.name.replace(/\.pdf$/i, ''))
      setStatus(nextChunks.length ? `Ready · ${nextChunks.length} passages indexed` : 'PDF uploaded but no readable text was found.')
      setMessages([
        {
          id: Date.now(),
          role: 'assistant',
          content: `The PDF is ready. Ask me anything about ${file.name}.`,
        },
      ])
    } catch (error) {
      console.error(error)
      setStatus('Could not read that PDF. Please try another file.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!input.trim() || !hasPdf) {
      return
    }

    const question = input.trim()
    setMessages((previous) => [
      ...previous,
      { id: Date.now(), role: 'user', content: question },
    ])
    setInput('')
    setIsLoading(true)
    setStatus('Searching the uploaded PDF...')

    try {
      const relevantChunks = getRelevantChunks(question, chunks)

      if (relevantChunks.length === 0) {
        setMessages((previous) => [
          ...previous,
          {
            id: Date.now() + 1,
            role: 'assistant',
            content: 'I could not find a strong match in the uploaded PDF. Try rephrasing your question or upload a different document.',
          },
        ])
        setStatus('No strong match found')
        return
      }

      const answer = [
        `Based on the uploaded document, the best match is on page ${relevantChunks[0].page}:`,
        `"${relevantChunks[0].text}"`,
        relevantChunks.length > 1
          ? `I also found supporting context on pages ${relevantChunks
              .slice(1)
              .map((chunk) => chunk.page)
              .join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')

      setMessages((previous) => [
        ...previous,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: answer,
        },
      ])
      setStatus(`Found ${relevantChunks.length} relevant passage(s)`)
    } catch (error) {
      console.error(error)
      setStatus('Something went wrong while answering.')
    } finally {
      setIsLoading(false)
    }
  }

  const onFileInputChange = (event) => {
    const file = event.target.files?.[0]
    if (file) {
      handleFile(file)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Local PDF RAG Chatbot</p>
          <h1>Ask questions from your uploaded documents.</h1>
          <p className="hero-text">
            This lightweight app reads a PDF in your browser, indexes its text, and answers questions from the most relevant sections.
          </p>
        </div>

        <label
          className={`upload-card ${dragActive ? 'drag-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragActive(false)
            const droppedFile = event.dataTransfer.files?.[0]
            if (droppedFile) {
              handleFile(droppedFile)
            }
          }}
        >
          <input type="file" accept="application/pdf" onChange={onFileInputChange} />
          <span className="upload-icon">⬆</span>
          <strong>Upload PDF</strong>
          <p>Drop your PDF here or browse files</p>
          <small>{uploadedFileName || 'Supported format: .pdf'}</small>
        </label>
      </header>

      <main className="chat-layout">
        <section className="chat-card">
          <div className="chat-header">
            <div>
              <p className="eyebrow">RAG Chat</p>
              <h2>{documentTitle}</h2>
            </div>
            <span className={`status-pill ${hasPdf ? 'ready' : ''}`}>{status}</span>
          </div>

          <div className="messages">
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
                <div className="message-content">{renderMessageContent(message.content)}</div>
              </article>
            ))}

            {isLoading ? (
              <div className="message assistant loading">
                <strong>Assistant</strong>
                <p>Searching the document…</p>
              </div>
            ) : null}
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={hasPdf ? 'Ask a question about the PDF' : 'Upload a PDF first'}
              disabled={!hasPdf || isLoading}
            />
            <button type="submit" disabled={!hasPdf || isLoading}>
              {isLoading ? 'Thinking…' : 'Ask'}
            </button>
          </form>
        </section>

        <aside className="info-card">
          <h3>How it works</h3>
          <ul>
            <li>Upload a PDF from the box above.</li>
            <li>The app extracts its text locally in your browser.</li>
            <li>Your questions are matched against the most relevant passages.</li>
          </ul>

          <div className="tip-box">
            <h4>Where to upload the PDF</h4>
            <p>Use the upload card at the top of the page. That is where your PDF file should be dropped or selected.</p>
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
