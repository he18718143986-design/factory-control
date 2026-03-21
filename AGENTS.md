# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

This is a **Factory Visitor Device Control System** (厂区访客管控系统) with two components:
- **Backend** (`backend/`): Node.js Express server (port 3000) with WebSocket, mDNS, ADB management, SQLite persistence, and admin web UI.
- **Visitor Android App** (`visitorapp/`): Kotlin Android app — requires Android SDK + JDK 17 to build; not buildable in the cloud VM.

### Running the backend

```bash
cd backend && node server.js
```

- Server listens on port 3000 (configurable via `PORT` env var).
- Admin dashboard: `http://localhost:3000/admin.html`
- Visitor welcome page: `http://localhost:3000/welcome`
- API base: `http://localhost:3000/api`

### Key gotcha: `better-sqlite3` native module

After `npm install`, you must run `npm rebuild better-sqlite3` if the pre-built binary doesn't match the current architecture. The update script handles this automatically. Without this step, the server will crash with `invalid ELF header`.

### ADB dependency

The backend shells out to `adb` for device management. ADB is **not** available in the cloud VM, but the server starts successfully without it — ADB polling will silently fail. Full end-to-end device pairing/control testing requires a physical Android device on the same LAN.

### No lint or automated test suite

This project does not include ESLint configuration, a test framework, or automated tests. Validation is done by starting the server and testing API endpoints manually.
