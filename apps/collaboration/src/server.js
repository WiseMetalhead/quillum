import { createCollaborationServer } from './collaboration.js'

const application = await createCollaborationServer()
await application.server.listen()

const address = application.server.address
process.stdout.write(`${JSON.stringify({
  timestamp: new Date().toISOString(),
  service: 'collaboration',
  event: 'service.started',
  address: address.address,
  port: address.port,
})}\n`)
