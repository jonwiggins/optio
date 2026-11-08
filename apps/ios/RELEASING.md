# Releasing Optio for iOS

TestFlight releases are internal for Jon, connected to his own server.
The app and widget share version `0.25.0` and a build number. `project.yml` is the
source of truth; XcodeGen regenerates the plists and entitlements.

## Apple account setup

Payment must have completed enrollment. In Xcode → Settings → Accounts, verify
that the account has a paid Developer Program team. The configured team is
`3H2754M9U5`; if the paid membership belongs to another team, update
`DEVELOPMENT_TEAM` in `project.yml` and regenerate.

Verify the app ID `dev.optio.ios`, extension ID `dev.optio.ios.widgets`, and App
Group `group.dev.optio.ios` under that team. Both targets need the same App Group
and shared keychain access group. The app needs Push Notifications. The
[Optio Agents app record](https://appstoreconnect.apple.com/apps/6821796813)
was created successfully: Apple ID `6821796813`, platform iOS, bundle ID and SKU
`dev.optio.ios`, primary language **English (U.S.)**. Apple rejected **Optio** as
already in use and accepted **Optio Agents**. Use this existing record when
uploading.
The bundle ID stays `dev.optio.ios`, and the Home Screen display name stays
**Optio**. Changing only the store listing name does not require a rebuild.
[Apple's app-record workflow](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/).

During the 2026-10-11 release preparation, the team initially appeared as
Personal. After enrollment activated, a signed archive succeeded with the push,
App Group, and shared Keychain entitlements intact. The first distribution
export then failed with `missing Xcode-Username` / `No Accounts`: Xcode's stored
Apple ID credentials needed refreshing. After signing back in, distribution
export succeeded with production push, matching shared access groups, and
debugging disabled. If that credential error recurs, sign back in under Accounts
(remove and re-add the Apple ID if needed), then retry export; no source rebuild
is needed for the refresh. Keep Push Notifications enabled.

Organizer reported `IDEDistribution.DistributionAppRecordProviderError error 0`
after creation. Its distribution log confirms HTTP 201 and the app's ID/name,
followed immediately by an empty bundle-ID lookup and `missingApp`. This suggests
a propagation delay: refresh App Store Connect and retry distribution from the
existing archive. Do not create another record to work around that error.

The command-line upload using Xcode's account still reported missing App Store
Connect access. Uploading the exported IPA with a team API key succeeded on
2026-10-11 (2026-10-12 UTC). Apple processed `0.16.0 (1)` as `VALID`, and its
internal state is `IN_BETA_TESTING`. The internal **Jon** group contains only
Jon's account, with an email invitation sent. Installation through TestFlight
and the physical-device acceptance checks remain to be confirmed.

## Build, archive, and upload

From `apps/ios`, with Xcode 27 and XcodeGen installed:

```bash
make test
make archive BUILD_NUMBER=2
make export
```

Increment `BUILD_NUMBER` for each new upload. The generated plist explicitly
uses `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`, including the extension.
The archive defaults to `build/Optio.xcarchive`; export writes `build/export`.
Override `ARCHIVE`, `EXPORT`, and `RELEASE_DD` to keep several builds.
`PROVISIONING_FLAGS` defaults to `-allowProvisioningUpdates`, allowing Xcode to
manage the team's profiles and certificates. Simulator tests also need normal
local signing for Keychain tests; do not set `CODE_SIGNING_ALLOWED=NO` on tests.

Open the archive in Xcode Organizer and run **Validate App**. Check the archived
version/build for the app and widget, the privacy report, and signing. Export
must give the app `aps-environment=production` and `get-task-allow=false`; both
bundles must have the correct App Group and expanded keychain access group.
The source entitlement is `development`, which Xcode promotes when exporting
for App Store Connect. A development-signed archive alone is not this check.

Upload from Organizer using App Store Connect distribution, or explicitly run:

```bash
make upload
```

The export/upload option files use automatic signing and preserve the supplied
build number. Build and export never upload implicitly. Keep the resulting
archive and dSYMs for crash reports. Never commit signing certificates, private
keys, or exported credentials.

If Organizer works but command-line upload cannot find the signed-in account,
an App Store Connect team API key with **App Manager** access can upload the
already exported IPA and manage screenshots and TestFlight. Store its `.p8`
outside the repository; the key ID and issuer ID come from Users and Access →
Integrations → App Store Connect API. With those values in the named environment
variables, Xcode 27's uploader accepts the key file directly:

```bash
xcrun altool --upload-package build/Optio-0.16.0-export/Optio.ipa \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" \
  --p8-file-path "$ASC_KEY_PATH" --wait
```

After a successful upload, verify processing and build availability in the
app's TestFlight page. The first release used this API-key route successfully.
[Apple's API key setup](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/).

After processing completes in App Store Connect, resolve any export-compliance
questions. The app currently declares no non-exempt encryption; revisit that
declaration if its encryption implementation changes. Create an internal group
containing Jon's App Store Connect account, add the build, and install through
TestFlight on the phone. External testing and a public invitation link are a
separate later step. [Apple's internal testing instructions](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

## Screenshots

Use the [isolated showcase lab](../../scripts/showcase/README.md) with fictional
data and its playback process. Install the current Debug app in dedicated
simulators, then capture each device from the repository root:

```bash
node apps/ios/scripts/capture-store-screenshots.mjs \
  /tmp/optio-showcase-4967.json <simulator-uuid> \
  apps/ios/build/TestFlightScreenshots/0.16.0/<device-size>
```

The script captures Overview, active work, recurring work, an agent conversation,
and the new-work form. The form is never submitted. It writes JPEGs directly
from the simulator, without an alpha channel, and a provenance manifest with the
installed app's version/build. Inspect every image before uploading; do not use
loading, permission, or error screens.

The v0.16 capture devices are iPhone 17 Pro (1206×2622), iPhone 17 Pro Max
(1320×2868), and iPad Pro 13-inch (2064×2752). Upload to the matching screenshot
sets in the English (U.S.) draft iOS version under Optio Agents. This prepares
the store listing; publishing it is separate from internal TestFlight.
[Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

All 15 v0.16 screenshots uploaded and reached Apple's `COMPLETE` state. The API
display types are `APP_IPHONE_61` for 1206×2622, `APP_IPHONE_67` for 1320×2868,
and `APP_IPAD_PRO_3GEN_129` for 2064×2752. Their legacy enum names differ from
the current device sizes; Apple accepted the native dimensions above.

## Privacy and networking declarations

The app and widget each bundle `PrivacyInfo.xcprivacy`. `CA92.1` covers their
own preferences; `1C8F.1` covers App Group preferences shared between them.
The app also declares `C617.1` for file metadata/size checks: pinned SwiftTerm
1.20.0 calls `stat` and `fstat` in its sandboxed Kitty graphics readers. The
widget does not link SwiftTerm. Neither target includes tracking SDKs.
Recheck the dependency sources and archive privacy report when upgrading
SwiftTerm. These required-reason declarations do not replace an accurate privacy
policy or App Store privacy answers for a future wider release.
[Apple's approved reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).

Optio accepts a user-selected server URL and supports user-managed HTTP servers
on LANs and tailnets. This is the reason for the app and widget's ATS exception;
HTTPS remains the default. App Group token access uses the signing prefix
expanded into `OptioSharedKeychainAccessGroup` in each executable's plist.

## Acceptance on the phone

- Pair with the actual server and a PAT, relaunch, switch servers, and verify an
  invalid token/offline server produces a useful error.
- Test HTTPS and the intended HTTP/tailnet address. Allow/deny local-network
  access and recover from denial in Settings.
- Open a task, Job, and review while logs arrive. Disconnect/reconnect and
  verify missed lines and the final state appear once. Repeat across an API
  restart using disposable work. Ensure budget-paused work shows its reason.
- Exercise Local chat and terminal input, work creation, keyboard layout, light
  and dark appearance, and large text. Smoke-test iPad too.
- Add a widget: it must see the same server and credentials. Forget a server
  and verify its widget access is removed.
- Configure production APNs on the trusted server using
  [the push setup guide](../../docs/ios-push.md). Verify the registered device's
  environment, send a test push, tap through, and try a needs-you notification
  and Live Activity action while the app is backgrounded. Check Watch mirroring
  if available. Simulator pushes do not verify APNs delivery.

Keep the APNs key on trusted server infrastructure. Later users running their
own independent servers will need a publisher-operated push relay or an
explicit no-remote-push mode; never distribute the publisher's key to them.
