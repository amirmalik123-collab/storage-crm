# Container Storage CRM

A web app for managing container self-storage units. Built with Node.js, Express, React, and PostgreSQL.

## Deploy free on Railway (recommended)

See the step-by-step guide you were given. In short:
1. Push this folder to a GitHub repository
2. Create a free Railway account at railway.app
3. Add a PostgreSQL database plugin
4. Deploy — Railway handles everything else

## Run locally

You need Node.js and a PostgreSQL database running locally, then:

```bash
# Create a .env file from the example
cp .env.example .env
# Edit .env and fill in your local DATABASE_URL

npm install
npm start
# Open http://localhost:3000
# Login: admin / admin123
```

## Environment variables

| Variable       | Required | Description                                      |
|----------------|----------|--------------------------------------------------|
| `DATABASE_URL` | Yes      | PostgreSQL connection string (Railway sets this) |
| `JWT_SECRET`   | Yes      | Long random string to secure login tokens        |
| `PORT`         | No       | HTTP port (Railway sets this automatically)      |

## Stack

| Layer    | Technology              |
|----------|-------------------------|
| Frontend | React 18, vanilla CSS   |
| Backend  | Node.js + Express       |
| Database | PostgreSQL               |
| Auth     | JWT + bcrypt            |
| Hosting  | Railway (free tier)     |
