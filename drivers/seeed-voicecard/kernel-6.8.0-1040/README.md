# Offline kernel assets

Populate this directory with the production Raspberry Pi kernel packages before running the installer. The bundle must include:

- `linux-image-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb`
- `linux-modules-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb`
- `linux-headers-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb`

These artifacts are not committed to the repository; copy the signed production builds into place prior to provisioning so the offline install can satisfy all `dpkg` dependencies.
