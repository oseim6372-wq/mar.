# Building SuperChat as an Android APK

This folder wraps your SuperChat web app in **Capacitor**, so it runs as a
real Android app (own icon, own window, installable via APK) instead of a
browser tab.

I can't run these steps myself — my sandbox has no internet access, so it
can't download the Android SDK or npm packages. You'll need to run this on
your own computer. It's about 15–20 minutes the first time.

## What you need installed first

1. **Node.js** (v18+) — https://nodejs.org
2. **Android Studio** — https://developer.android.com/studio
   (this also installs the Android SDK, which is required)
3. This project folder (`superchat-android/`), unzipped somewhere on your machine.

## Steps

Open a terminal in the `superchat-android` folder.

### 1. Install dependencies
```bash
npm install
```

### 2. Add the Android platform
```bash
npx cap add android
```
This generates an `android/` folder — the actual native Android project.

### 3. Sync your web app into the Android project
```bash
npx cap sync android
```
Run this again any time you change `www/index.html`.

### 4. Open in Android Studio
```bash
npx cap open android
```
This launches Android Studio with the project loaded.

### 5. Build the APK
In Android Studio:
- Wait for Gradle sync to finish (progress bar at the bottom).
- Go to **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
- When it finishes, click the **"locate"** link in the notification, or find
  it at:
  ```
  android/app/build/outputs/apk/debug/app-debug.apk
  ```

### 6. Install it on your phone
- Copy `app-debug.apk` to your Android device (USB, email, Google Drive, etc.)
- On the phone, tap the file to install. You may need to allow
  **"Install unknown apps"** for whatever app you used to open it
  (Settings → Apps → Special access → Install unknown apps).

That's it — SuperChat will now appear as its own app icon on the phone,
talking to the same Firebase backend as before.

## Notes / things to know

- **This is a debug build.** It works fine for personal use and testing,
  but if you ever want to publish it on the Play Store, you'd need a
  signed **release** build instead (Android Studio: Build → Generate
  Signed Bundle/APK). That requires creating a signing key — ask me if
  you get there and I'll walk you through it.
- **Internet permission** is included by default in Capacitor's Android
  template, so Firebase (auth + realtime database) will work normally.
- **App icon/name**: currently using Capacitor's default icon and the name
  "SuperChat" (set in `capacitor.config.json`). You can swap in a custom
  icon by replacing the images in `android/app/src/main/res/mipmap-*/`
  after step 2, or ask me to generate one and I'll fold it in first.
- **Updating the app later**: edit `www/index.html`, run
  `npx cap sync android`, then rebuild the APK in Android Studio (step 5).
  No need to redo steps 1–2.
