# DG Transcribe AI

DG Transcribe AI is a production-ready AI SaaS platform that allows users to transcribe, summarize, and translate video and audio files with ease.

## Features

- **Auth**: Secure Google Sign-In via Firebase Authentication.
- **Upload**: Drag-and-drop support for MP4, MP3, WAV, and MOV.
- **Transcribe**: Automated speech-to-text with speaker detection using Gemini AI.
- **Summarize**: AI-generated concise summaries, bullet points, and key takeaways.
- **Translate**: Multi-language support (Khmer, English, Chinese, Japanese, Korean, Thai).
- **Export**: Download transcripts as PDF, TXT, or SRT.
- **UI/UX**: Modern dark-mode interface with glassmorphism and smooth animations.

## Tech Stack

- **Frontend**: React, Tailwind CSS, Framer Motion, Lucide Icons.
- **Backend**: Node.js, Express.js.
- **AI**: Google Gemini AI (1.5 Flash) via `@google/genai`.
- **Database/Storage**: Firebase Firestore & Firebase Storage.
- **PDF Generation**: PDFKit on the backend.

## Getting Started

1. **Prerequisites**:
   - Node.js (v18+)
   - Firebase Project
   - Gemini API Key

2. **Environment Variables**:
   Copy `.env.example` to `.env` and fill in:
   - `GEMINI_API_KEY`
   - Firebase configuration in `firebase-applet-config.json`

3. **Installation**:
   ```bash
   npm install
   ```

4. **Development**:
   ```bash
   npm run dev
   ```

5. **Build**:
   ```bash
   npm run build
   ```

## Folder Structure

- `src/`: Frontend React source code.
  - `components/`: UI components.
  - `lib/`: Firebase and Utility initializations.
  - `services/`: Gemini AI integration logic.
- `server.ts`: Express backend for API routes and PDF generation.
- `firestore.rules`: Security rules for database protection.

## License

Apache-2.0
