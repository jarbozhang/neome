import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })
import fs from 'fs'
import { randomUUID } from 'crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import sharp from 'sharp'
import { WSMessage } from '../shared/types'
import { VoiceSession } from './voiceSession'

const app = Fastify({ logger: true })

// 解析 glTF Binary (.glb/.vrm)，将所有 PNG 贴图的 alpha 设为 255
// 支持处理后图片变大的情况（重建 BIN chunk + 更新 bufferView）
async function processVRM(glbBuffer: Buffer): Promise<Buffer> {
  const magic = glbBuffer.readUInt32LE(0)
  if (magic !== 0x46546C67) throw new Error('Not a valid glTF binary')
  const version = glbBuffer.readUInt32LE(4)

  // Chunk 0: JSON
  const jsonChunkLength = glbBuffer.readUInt32LE(12)
  if (glbBuffer.readUInt32LE(16) !== 0x4E4F534A) throw new Error('First chunk is not JSON')
  const jsonStr = glbBuffer.subarray(20, 20 + jsonChunkLength).toString('utf-8')
  const gltf = JSON.parse(jsonStr)

  // Chunk 1: BIN
  const binOffset = 20 + jsonChunkLength
  const binChunkLength = glbBuffer.readUInt32LE(binOffset)
  if (glbBuffer.readUInt32LE(binOffset + 4) !== 0x004E4942) throw new Error('Second chunk is not BIN')
  const originalBin = glbBuffer.subarray(binOffset + 8, binOffset + 8 + binChunkLength)

  const images = gltf.images || []
  const bufferViews = gltf.bufferViews || []

  // 收集所有 bufferView 的数据段，处理图片后重建
  const processedImages = new Map<number, Buffer>() // bufferViewIndex → processedBuffer

  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (img.bufferView === undefined) continue
    const bv = bufferViews[img.bufferView]
    const offset = bv.byteOffset || 0
    const length = bv.byteLength
    const mimeType = img.mimeType || ''
    if (!mimeType.includes('png') && !mimeType.includes('jpeg') && !mimeType.includes('jpg')) continue

    try {
      const imgSlice = originalBin.subarray(offset, offset + length)
      const meta = await sharp(imgSlice).metadata()
      if (meta.channels !== 4) continue

      const { data: rawPixels, info } = await sharp(imgSlice).raw().toBuffer({ resolveWithObject: true })
      // un-premultiply RGB 并设 alpha=255
      for (let p = 0; p < rawPixels.length; p += 4) {
        const a = rawPixels[p + 3]
        if (a > 0 && a < 255) {
          rawPixels[p]     = Math.min(255, Math.round(rawPixels[p]     * 255 / a))
          rawPixels[p + 1] = Math.min(255, Math.round(rawPixels[p + 1] * 255 / a))
          rawPixels[p + 2] = Math.min(255, Math.round(rawPixels[p + 2] * 255 / a))
        }
        rawPixels[p + 3] = 255
      }
      const processed = await sharp(rawPixels, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png({ compressionLevel: 9 }).toBuffer()

      processedImages.set(img.bufferView, processed)
      console.log(`Image ${i}: alpha fixed (${info.width}x${info.height}, ${length}→${processed.length})`)
    } catch (err) {
      console.log(`Image ${i}: processing failed, skipped`, err)
    }
  }

  // 重建 BIN chunk：按 bufferView 顺序排列，替换处理过的图片
  const segments: Buffer[] = []
  let currentOffset = 0
  for (let bvIdx = 0; bvIdx < bufferViews.length; bvIdx++) {
    const bv = bufferViews[bvIdx]
    const origOffset = bv.byteOffset || 0
    const origLength = bv.byteLength

    let data: Buffer
    if (processedImages.has(bvIdx)) {
      data = processedImages.get(bvIdx)!
    } else {
      data = Buffer.from(originalBin.subarray(origOffset, origOffset + origLength))
    }

    // 4 字节对齐
    const padding = (4 - (currentOffset % 4)) % 4
    if (padding > 0) {
      segments.push(Buffer.alloc(padding, 0))
      currentOffset += padding
    }

    bv.byteOffset = currentOffset
    bv.byteLength = data.length
    segments.push(data)
    currentOffset += data.length
  }

  const newBin = Buffer.concat(segments)
  // 更新 buffer 总大小
  if (gltf.buffers && gltf.buffers.length > 0) {
    gltf.buffers[0].byteLength = newBin.length
  }

  // 重新组装 GLB
  const newJsonStr = JSON.stringify(gltf)
  const jsonBuf = Buffer.from(newJsonStr, 'utf-8')
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4
  const jsonChunkData = Buffer.concat([jsonBuf, Buffer.alloc(jsonPadding, 0x20)])
  const binPadding = (4 - (newBin.length % 4)) % 4
  const binChunkData = Buffer.concat([newBin, Buffer.alloc(binPadding, 0)])

  const totalSize = 12 + 8 + jsonChunkData.length + 8 + binChunkData.length
  const result = Buffer.alloc(totalSize)

  result.writeUInt32LE(0x46546C67, 0)
  result.writeUInt32LE(version, 4)
  result.writeUInt32LE(totalSize, 8)
  result.writeUInt32LE(jsonChunkData.length, 12)
  result.writeUInt32LE(0x4E4F534A, 16)
  jsonChunkData.copy(result, 20)
  const binStart = 20 + jsonChunkData.length
  result.writeUInt32LE(binChunkData.length, binStart)
  result.writeUInt32LE(0x004E4942, binStart + 4)
  binChunkData.copy(result, binStart + 8)

  return result
}

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

    // VRM 预处理路由：剥离所有嵌入 PNG 贴图的 alpha 通道
    // 解决 iOS WebView premultiplied alpha 导致贴图颜色丢失的问题
    const vrmCache = new Map<string, Buffer>()

    app.get('/vrm/:filename', async (request, reply) => {
      const { filename } = request.params as { filename: string }
      const { raw } = request.query as { raw?: string }
      const filePath = path.resolve(__dirname, '../../assets/models', filename)

      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'VRM not found' })
      }

      // raw=true: 返回原始 VRM（MToon 渲染需要保留原始 alpha）
      if (raw === 'true') {
        return reply.type('model/gltf-binary').send(fs.readFileSync(filePath))
      }

      // 缓存命中
      if (vrmCache.has(filePath)) {
        return reply.type('model/gltf-binary').send(vrmCache.get(filePath))
      }

      try {
        const buf = fs.readFileSync(filePath)
        const result = await processVRM(buf)
        vrmCache.set(filePath, result)
        return reply.type('model/gltf-binary').send(result)
      } catch (err) {
        app.log.error(err, 'VRM processing failed')
        // fallback: 返回原始文件
        return reply.type('model/gltf-binary').send(fs.readFileSync(filePath))
      }
    })

    // ---------- MQTT 出杯 ----------
    async function makeCoffee(recipe: string): Promise<void> {
      const url = 'http://mqtt-t.bfelab.com/api/v5/publish'

      const body = {
        payload_encoding: 'plain',
        topic: 'demo/cmd/make',
        qos: 1,
        payload: JSON.stringify({
          order_id: randomUUID(),
          index_id: '1',
          msg_id: randomUUID(),
          recipe_key: recipe,
          sku_name: `${recipe}(量贩)`,
        }),
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic OTQzOTA5MzRmODAwNDIwZDo2RHh0dURiVTNuUDZxR2Vzdlp6VUlPS2NGS2FBMXg0ZlNIVGNVYkhSQ3RC',
        },
        body: JSON.stringify(body),
      })
      console.log('[MQTT] makeCoffee response:', res.status)
    }

    // WebSocket 路由（必须在 register(websocket) 之后注册）
    app.get('/ws', { websocket: true }, (socket, req) => {
      app.log.info('Client connected')

      const voiceSession = new VoiceSession(socket, (recipe) => {
        makeCoffee(recipe).catch(err => app.log.error(err, 'MQTT failed'))
      })
      voiceSession.start().catch(err => {
        app.log.error(err, 'VoiceSession start failed')
      })

      socket.on('message', (raw) => {
        try {
          const msg: WSMessage = JSON.parse(raw.toString())

          switch (msg.type) {
            case 'audio_chunk': {
              const payload = msg.payload as { audio: string }
              voiceSession.appendAudio(payload.audio)
              break
            }
            case 'interrupt': {
              voiceSession.interrupt()
              break
            }
            case 'session_reset': {
              voiceSession.resetSession()
              break
            }
            case 'state_change': {
              const state = (msg.payload as { state: string } | null)?.state
              app.log.info({ state }, 'Client state_change (logged only)')
              break
            }
            default:
              app.log.info({ type: msg.type }, 'Unhandled message type')
          }
        } catch (err) {
          app.log.error(err, 'Failed to parse message')
        }
      })

      socket.on('close', () => {
        app.log.info('Client disconnected')
        voiceSession.destroy()
      })

      socket.on('error', (err) => {
        app.log.error(err, 'WebSocket error')
        voiceSession.destroy()
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
