# QueueFlow

Full-stack queue management app. Express + SQLite (better-sqlite3) + JWT auth, with a dependency-free vanilla JS frontend.

## Run
```
npm install
npm start        # http://localhost:3000
npm test         # API smoke test
```
Set `JWT_SECRET` and `PORT` via environment variables for production.

## Features
- Manager sign-up / login (bcrypt + JWT); each manager only sees their own queues
- Create named queues; add people (a numbered token like T-001 is issued)
- Live waiting list, move tokens up/down, cancel, call the top token with one click, mark done
- Dashboard: average / longest wait, service time, served vs cancelled, queue-length trend (24h), wait per token

## API
`POST /api/auth/register|login` · `GET|POST /api/queues` · `GET|DELETE /api/queues/:id` · `POST /api/queues/:id/tokens` · `POST /api/queues/:id/serve` · `POST /api/tokens/:id/move|complete|cancel` · `GET /api/analytics?queue_id=`
