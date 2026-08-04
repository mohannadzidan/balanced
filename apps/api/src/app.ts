import Fastify, { type FastifyInstance } from "fastify"

export function build(): FastifyInstance {
  const app = Fastify()

  app.get("/health", async () => {
    return { status: "ok" }
  })

  return app
}
