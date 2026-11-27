# Claro Android — Play Store AAB, APK & Folder Guide

## Exact Folder Locations (Where to Place & Find Files)
1. **Place your Firebase config file here:**
   - `android-source/app/google-services.json`
2. **Place your release signing keystore here (never commit to Git):**
   - `android-source/app/claro-release.jks`
3. **Generated APK & AAB output folders (after building):**
   - **Play Store App Bundle (`.aab`)**: `android-source/app/build/outputs/bundle/release/app-release.aab`
   - **Installable Android APK (`.apk`)**: `android-source/app/build/outputs/apk/release/app-release.apk`
   - **Debug APK (for quick phone testing)**: `android-source/app/build/outputs/apk/debug/app-debug.apk`

---

## Method A: Native Android Project (Kotlin + Jetpack Compose)
1. Open the extracted `android-source/` folder in **Android Studio**.
2. Download `google-services.json` from Firebase Console (`com.claro.app`) and place it in `android-source/app/google-services.json`.
3. In Firebase Console -> **Authentication -> Sign-in method**, enable **Google**, **Email/Password**, and **Phone** (add your SHA-1 / SHA-256 fingerprint).
4. Build APK and Play Store AAB from Android Studio (**Build -> Generate Signed Bundle / APK**) or terminal:
   ```bash
   # Build Debug APK
   ./gradlew assembleDebug

   # Build Signed Release APK
   ./gradlew assembleRelease

   # Build Signed Play Store App Bundle (.aab)
   ./gradlew bundleRelease
   ```
5. Upload `app/build/outputs/bundle/release/app-release.aab` directly to **Google Play Console**.

---

## Method B: Instant Play Store AAB / APK from the Claro PWA (Bubblewrap)
Because the Claro web app includes a full Web App Manifest and Service Worker, you can also package it directly into a signed `.aab` and `.apk` using Google's Bubblewrap CLI:
```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest="https://ais-pre-x6vzwrkkfc7urh5uizhj7k-561146321083.asia-southeast1.run.app/manifest.webmanifest"
bubblewrap build
```
Bubblewrap outputs `app-release-signed.apk` and `app-release-bundle.aab` in the current working folder, ready for Play Console upload.
