/** Keyless Codex interruption peer for the headless Session snapshot. */

import { once } from 'node:events'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

interface CodexWebSocketFixture {
  readonly baseURL: string
  readonly requests: number
  readonly errors: readonly Error[]
  close(): Promise<void>
}

/**
 * Start a keyless Codex peer: interrupt a tool call, then recover through SSE.
 * pi-ai disables WebSocket for the session after the first transport failure.
 * @returns the ephemeral endpoint, observed calls, and an awaited disposer.
 */
export async function startCodexWebSocketRetryFixture(): Promise<CodexWebSocketFixture> {
  const errors: Error[] = []
  let requests = 0
  const server = createServer((request, response) => {
    request.on('error', error => errors.push(error))
    response.on('error', error => errors.push(error))
    request.resume()
    request.once('end', () => {
      requests += 1
      const item = {
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Recovered.' }],
      }
      const events = [
        { type: 'response.created', response: { id: 'response-1' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', item_id: 'message-1', output_index: 0, content_index: 0, delta: 'Recovered.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: {
          id: 'response-1', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        } },
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
  })
  const websocket = new WebSocketServer({ server })
  server.on('error', error => errors.push(error))
  websocket.on('error', error => errors.push(error))
  websocket.on('connection', (socket) => {
    socket.on('error', error => errors.push(error))
    socket.once('message', () => {
      requests += 1
      // Start the response so the premature close reaches the adapter, not pre-stream SSE fallback.
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'partial-1' } }))
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call-1', type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '' },
      }))
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-1', delta: '{"command":"printf failed-partial"',
      }), (error) => {
        if (error) errors.push(error)
        socket.terminate()
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Codex fixture did not bind a TCP port')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    get requests() { return requests },
    errors,
    async close() {
      for (const socket of websocket.clients) socket.terminate()
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          websocket.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          })
          server.closeAllConnections()
        }),
      ])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
  }
}
