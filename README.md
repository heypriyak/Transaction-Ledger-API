# Transaction Ledger API

## Requirements

- Node.js 20+
- npm

## Run locally

```bash
npm install
npm start
```

The API listens on `http://localhost:3000` and stores data in `ledger.db`. Set `PORT` or `DATABASE_FILE` to override these defaults.

Amounts are integer values in the smallest currency unit (for example, cents). This avoids floating-point money errors.

## Example

```bash
curl -X POST http://localhost:3000/accounts \
  -H "content-type: application/json" \
  -d "{\"name\":\"Operating Account\"}"

curl -X POST http://localhost:3000/accounts/1/transactions \
  -H "content-type: application/json" \
  -d "{\"type\":\"credit\",\"amount\":10000,\"reference_id\":\"invoice-001\",\"description\":\"Invoice payment\"}"
```

See [API.md](./API.md) for all endpoints, request bodies, response shapes, and assumptions.

## Tests

```bash
npm test
```
