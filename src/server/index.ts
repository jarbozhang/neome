import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { createApp } from './app'

const start = async () => {
  try {
    const app = await createApp()
    const port = Number(process.env.PORT) || 9527
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`Server running on http://0.0.0.0:${port}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()
