import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/engine/db/schema.ts',
  out: './src/engine/db/migrations'
})
