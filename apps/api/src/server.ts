import { build } from "./app.js"

const app = build()

app.listen({ port: 3001 }, (err, address) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  app.log.info(`server listening at ${address}`)
})
