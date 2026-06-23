# Android release & signing

How to build a signed release APK, and how to set up + **back up** the signing
keystore. `applicationId` is `com.rafitol.ytdownloader`.

> ⚠️ **Losing the keystore = you can never update the app again.** A new keystore
> produces a different signature, which Android (and any store) rejects as a
> different app. Back it up the moment you create it (see below).

## 1. Build the web assets for native

Always use the capacitor mode — a plain `npm run build` ships a config that
breaks login (HTML-as-JSON error) on device:

```sh
cd frontend
npm run cap:sync   # = build:mobile (mode capacitor, loads VITE_API_BASE) + cap sync
```

## 2. Create the keystore (once)

```sh
keytool -genkey -v \
  -keystore ytdownloader-release.jks \
  -alias ytdownloader \
  -keyalg RSA -keysize 2048 -validity 10000
```

Store it **outside** the repo (`*.jks` / `*.keystore` / `keystore.properties` are
gitignored under `frontend/android/`, but don't rely on that — keep the file
elsewhere). Immediately copy it to at least two durable locations (password
manager attachment, encrypted backup, etc.) and record the store/key passwords
and the alias next to it.

## 3. Wire signing into Gradle (once)

Create `frontend/android/keystore.properties` (gitignored):

```properties
storeFile=/absolute/path/to/ytdownloader-release.jks
storePassword=…
keyAlias=ytdownloader
keyPassword=…
```

Then add a signing config to `frontend/android/app/build.gradle`. The guard keeps
debug builds working when the properties file is absent (e.g. in CI):

```gradle
// above android { … }
def keystorePropsFile = rootProject.file("keystore.properties")
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) {
    keystoreProps.load(new FileInputStream(keystorePropsFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            if (keystorePropsFile.exists()) {
                signingConfig signingConfigs.release
            }
            // Optional: shrink + obfuscate the release APK.
            // minifyEnabled true
            // proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

## 4. Build the signed APK

```sh
cd frontend/android
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

## 5. Bump the version before each release

In `frontend/android/app/build.gradle`, increment `versionCode` (integer, must go
up every release) and set a human `versionName`:

```gradle
versionCode 2
versionName "1.1"
```

## Notes

- The manifest declares only `INTERNET` + the two foreground-service permissions
  the media-session plugin needs — keep it minimal.
- `androidScheme: 'https'` means no cleartext traffic; the backend must be HTTPS.
- There is currently no automated APK build in CI (the keystore can't live
  there). Releases are built locally with the steps above.
