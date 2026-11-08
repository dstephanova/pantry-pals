#!/bin/bash
set -e
cd "$(dirname "$0")"
SDK=/usr/lib/android-sdk/platforms/$(ls /usr/lib/android-sdk/platforms | head -1)/android.jar
DX=/usr/share/java/com.android.dx.jar
rm -rf build && mkdir -p build/classes
cp ../web/dist/index.html assets/index.html
javac -nowarn --release 8 -cp "$SDK" -d build/classes $(find src -name '*.java') 2>&1 | grep -v "warning\|^Note" || true
java -cp $DX com.android.dx.command.Main --dex --output=build/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK" -F build/unsigned.apk
(cd build && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f 4 build/unsigned.apk build/aligned.apk
[ -f ../pantry.keystore ] || keytool -genkeypair -keystore ../pantry.keystore -storepass pantrypals -keypass pantrypals -alias pp -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Pantry Pals" >/dev/null 2>&1
apksigner sign --ks ../pantry.keystore --ks-pass pass:pantrypals --key-pass pass:pantrypals --ks-key-alias pp --out build/PantryPals.apk build/aligned.apk
apksigner verify --print-certs build/PantryPals.apk | head -2
ls -la build/PantryPals.apk
