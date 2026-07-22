#!/usr/bin/env bash
#
# Build a signed, sideloadable Bill Note APK with the Android SDK build-tools
# directly (no Gradle/AndroidX needed — the app uses only framework APIs).
#
# Prereqs: JDK + an Android SDK with platforms;android-34 and
# build-tools;34.0.0. Point ANDROID_SDK_ROOT at it.
#
# Usage:  ANDROID_SDK_ROOT=/path/to/sdk bash android/build.sh
# Output: android/BillNote.apk  (debug-signed; fine for sideloading)
#
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-/home/user/android-sdk}"
# Prefer the newest installed build-tools (older d8 had an anonymous-class bug).
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
AJAR="$SDK/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app/src/main"
OUT="$HERE/build"

[ -f "$AJAR" ] || { echo "android.jar not found at $AJAR"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/obj" "$OUT/dex"

echo "1/7 aapt2 compile resources"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/compiled/res.zip"

echo "2/7 aapt2 link (base apk + R.java)"
"$BT/aapt2" link -o "$OUT/base.apk" \
  -I "$AJAR" \
  --manifest "$APP/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 21 --target-sdk-version 34 \
  "$OUT/compiled/res.zip"

echo "3/7 javac"
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/srcs.txt"
# Target Java 8 bytecode: Android's norm, and it avoids the nestmate class
# format that older d8/R8 mishandles on anonymous inner classes.
javac -source 8 -target 8 -g:none -nowarn -encoding UTF-8 -classpath "$AJAR" -d "$OUT/obj" @"$OUT/srcs.txt" 2>/dev/null

echo "4/7 d8 (dex)"
mapfile -t CLASSES < <(find "$OUT/obj" -name '*.class')
"$BT/d8" --release --min-api 21 --lib "$AJAR" --output "$OUT/dex" "${CLASSES[@]}"

echo "5/7 assemble apk"
cp "$OUT/base.apk" "$OUT/app-unsigned.apk"
( cd "$OUT/dex" && zip -q "$OUT/app-unsigned.apk" classes.dex )

echo "6/7 zipalign"
"$BT/zipalign" -f 4 "$OUT/app-unsigned.apk" "$OUT/app-aligned.apk"

echo "7/7 sign"
KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias billnote -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Bill Note, O=Joseph Dental & Aesthetic Wellness" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$HERE/BillNote.apk" "$OUT/app-aligned.apk"
"$BT/apksigner" verify --print-certs "$HERE/BillNote.apk" >/dev/null && echo "signature OK"

echo "Built: $HERE/BillNote.apk"
