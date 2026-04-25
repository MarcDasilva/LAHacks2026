Setup
Set up ZETIC Melange in your Xcode project.

This guide targets ZeticMLange iOS 1.6.0 — the recommended version and the one all API reference pages are written against.

This guide walks you through adding the ZETIC Melange SDK to your iOS project. Melange provides a unified Swift interface that handles compilation, optimization, and execution on the Apple Neural Engine automatically.

Prerequisites
Xcode 14 or later
A physical iOS device (iPhone 8 or later recommended)
iOS 15.0+
A Personal Key from the Melange Dashboard
Simulators do not have Neural Engine hardware. Always test on a physical device for accurate performance results.

Add Melange Package
We use Swift Package Manager (SPM) to automatically resolve and link the binary dependencies required for NPU acceleration.

Open your project in Xcode.
Go to File then Add Package Dependencies.
Enter the package URL: https://github.com/zetic-ai/ZeticMLangeiOS
Set the dependency rule to Exact Version 1.6.0 (or Up to Next Major Version from 1.6.0).
Click Add Package.
Link Accelerate.framework
ZeticMLange depends on Apple's Accelerate framework (for vDSP and BLAS kernels). SPM does not link this system framework automatically, so you need to add it manually:

Select your app target in Xcode.
Open General → Frameworks, Libraries, and Embedded Content (or equivalently, Build Phases → Link Binary With Libraries).
Click +, search for Accelerate.framework, and add it.
Skipping this step causes linker errors such as Undefined symbol: _vDSP_vmul or _cblas_sgemm$NEWLAPACK$ILP64 at build time. See iOS Issues → Undefined Accelerate Symbols if you hit these errors.

This manual step is a temporary workaround. A future SDK release will auto-link Accelerate through SPM so this step can be removed.

Select Target
Link the ZeticMLange library to your specific application target:

Select your target in the Add to Target column.
Click Add Package.
Verify Setup
Add a simple initialization test to confirm the SDK is working:


import ZeticMLange
// Test initialization
let model = try ZeticMLangeModel(personalKey: PERSONAL_KEY, name: MODEL_NAME)
If the initialization completes without error, your setup is ready.

The initializer performs a network call on first use to download the model binary. The binary is cached locally after the first download, so subsequent initializations are fast.

