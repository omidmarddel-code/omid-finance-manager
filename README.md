# مدیریت مالی امید

اپلیکیشن مالی شخصی فارسی و آفلاین با HTML، CSS، JavaScript و Capacitor.

## اجرا و توسعه

```powershell
npm install
npm run dev
```

برای بازکردن پروژه در Android Studio، پوشهٔ `android` را باز کنید. پس از تغییر کد وب، `npm run android:sync` را اجرا کنید.

داده‌های Android در SQLite محلی ذخیره می‌شوند. اجرای مرورگری برای توسعه از IndexedDB استفاده می‌کند. اثرانگشت توسط Android تأیید می‌شود و دادهٔ بیومتریک در برنامه ذخیره نمی‌شود.

## ساخت Release

از Android Studio گزینهٔ **Build > Generate Signed Bundle / APK** را انتخاب و برای انتشار، keystore خودتان را معرفی یا ایجاد کنید. کلید خصوصی را در مخزن قرار ندهید.

ساخت Gradle بدون امضا:

```powershell
cd android
\.\gradlew.bat assembleRelease bundleRelease
```

خروجی APK بدون امضا در `android/app/build/outputs/apk/release/app-release-unsigned.apk` و خروجی AAB در `android/app/build/outputs/bundle/release/app-release.aab` قرار می‌گیرد. برای انتشار واقعی، خروجی signed را از Android Studio تولید کنید.
