plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "kr.krl.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "kr.krl.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = (findProperty("VERSION_CODE") as String?)?.toInt() ?: 2
        versionName = (findProperty("VERSION_NAME") as String?) ?: "0.2.0"
        // 기본 서버 주소 (빌드 시 -PKRL_SERVER=https://krl.kr)
        buildConfigField("String", "KRL_SERVER", "\"${(findProperty("KRL_SERVER") as String?) ?: "https://krl.kr"}\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        val ks = System.getenv("KRL_KEYSTORE")
        if (ks != null && file(ks).exists()) {
            create("release") {
                storeFile = file(ks)
                storePassword = System.getenv("KRL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KRL_KEY_ALIAS") ?: "krl"
                keyPassword = System.getenv("KRL_KEY_PASSWORD") ?: System.getenv("KRL_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
