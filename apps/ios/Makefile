# Common iOS workflows. Requires Xcode + `brew install xcodegen`.
SIM ?= iPhone 17 Pro
DD  ?= build/DerivedData
XCB = xcodebuild -project Optio.xcodeproj -scheme Optio -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath $(DD) -skipPackagePluginValidation -skipMacroValidation

.PHONY: generate build test run types clean

generate:
	xcodegen generate

build: generate
	$(XCB) build | $(xcbeautify_or_tail)

test: generate
	$(XCB) test | $(xcbeautify_or_tail)

run: build
	xcrun simctl boot "$(SIM)" 2>/dev/null || true
	open -a Simulator
	xcrun simctl install booted $(DD)/Build/Products/Debug-iphonesimulator/Optio.app
	xcrun simctl launch booted dev.optio.ios

# Regenerate Swift models from packages/shared TypeScript types.
types:
	cd ../.. && pnpm gen:swift

clean:
	rm -rf $(DD) Optio.xcodeproj

xcbeautify_or_tail := $(shell command -v xcbeautify >/dev/null && echo xcbeautify || echo "grep -E '\\.swift:[0-9]+:[0-9]+: (error|warning)|BUILD (SUCCEEDED|FAILED)|TEST (SUCCEEDED|FAILED)|Test Suite|Executed'")
