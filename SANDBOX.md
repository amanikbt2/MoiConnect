# Local isolated web sandbox

1. Start a local MongoDB Community Server on `127.0.0.1:27017`.
2. In the backend folder, run `npm run dev:sandbox`. Sandbox mode uses only the `mconnect_sandbox` database, binds the API to `127.0.0.1:5000`, blocks Expo push delivery and Cloudinary writes, and disables scheduled forum posts. It never loads the regular `.env` file.
3. In a second terminal, run `npm run web` from the frontend folder and open the local Expo web URL. A page opened on `localhost` or `127.0.0.1` is pinned to `http://localhost:5000` even if `EXPO_PUBLIC_API_URL` is set to production.

To use AI replies in the sandbox, copy `.env.sandbox.example` to `.env.sandbox` and add a test Gemini key there. AI prompts still go to the Gemini API; no community messages or pushes go to production users. Do not copy production MongoDB data or registered device tokens into the sandbox database.
