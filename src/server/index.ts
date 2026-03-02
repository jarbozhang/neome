import path from 'path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { WSMessage } from '../shared/types'

const app = Fastify({ logger: true })

const start = async () => {
  try {
    // CORS — 允许 WebView (origin: null) 和局域网访问
    await app.register(cors, { origin: true })
    await app.register(websocket)

    // 托管 assets 静态文件（VRM 模型等）
    await app.register(fastifyStatic, {
      root: path.resolve(__dirname, '../../assets'),
      prefix: '/assets/',
    })

    // Health check
    app.get('/health', async () => {
      return { status: 'ok' }
    })

    // WebSocket 路由（必须在 register(websocket) 之后注册）
    app.get('/ws', { websocket: true }, (socket, req) => {
      app.log.info('Client connected')

      socket.on('message', (raw) => {
        try {
          const msg: WSMessage = JSON.parse(raw.toString())
          app.log.info({ type: msg.type }, 'Received message')

          if (msg.type === 'state_change') {
            const state = (msg.payload as { state: string } | null)?.state
            app.log.info({ state }, 'State changed')
            // 回传确认（后续会改为服务端主动触发状态变更）
            socket.send(JSON.stringify(msg))
          }
        } catch (err) {
          app.log.error(err, 'Failed to parse message')
        }
      })

      socket.on('close', () => {
        app.log.info('Client disconnected')
      })

      socket.on('error', (err) => {
        app.log.error(err, 'WebSocket error')
      })
    })

    const port = Number(process.env.PORT) || 9527
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`Server running on http://0.0.0.0:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
