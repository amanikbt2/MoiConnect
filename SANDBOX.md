# Local isolated web sandbox

1. Start a local MongoDB Community Server on `127.0.0.1:27017`.
2. In the backend folder, run `npm run dev:sandbox`. Sandbox mode uses only the `mconnect_sandbox` database, binds the API to `127.0.0.1:5000`, blocks Expo push delivery and automatic Cloudinary writes, and disables scheduled forum posts. It never loads the regular `.env` file.
3. In a second terminal, run `npm run web` from the frontend folder and open the local Expo web URL. A page opened on `localhost` or `127.0.0.1` is pinned to `http://localhost:5000` even if `EXPO_PUBLIC_API_URL` is set to production.

To use AI replies in the sandbox, copy `.env.sandbox.example` to `.env.sandbox` and add a test Gemini key there. AI prompts still go to the Gemini API; no community messages or pushes go to production users. Do not copy production MongoDB data or registered device tokens into the sandbox database.

To test AI material matching with real library records, keep the production Mongo URI in the ignored backend `.env`, start local MongoDB, then run `npm.cmd run seed:sandbox-materials`. The script reads up to five recent, approved, non-demo materials per category from the source `papers` collection and inserts only those material documents into local `mconnect_sandbox.papers`. It does not read users or other production collections and issues no writes to the source database. Existing local material records are left unchanged.

To keep material files off the main MConnect Cloudinary cloud, create a separate Cloudinary cloud/account named for the sandbox. Copy `.env.sandbox.example` to `.env.sandbox`, then fill only `CLOUDINARY_SANDBOX_CLOUD_NAME`, `CLOUDINARY_SANDBOX_API_KEY`, and `CLOUDINARY_SANDBOX_API_SECRET` with that separate cloud's values. Run `npm.cmd run copy:sandbox-materials-cloudinary`. This uploads local sandbox material files to `MConnect-sandbox/materials` in the separate cloud and updates only local `mconnect_sandbox.papers` URLs. It refuses to use the same cloud name configured in the main backend `.env`.
