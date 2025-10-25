# Seeed Voicecard Asset Bundle

This directory contains the resources required to provision the Seeed ReSpeaker 2-Mic Pi HAT v2.0 on Ubuntu 24.04 LTS with the Raspberry Pi `6.8.0-1040-raspi` kernel.

## Contents

- `install.sh` – Hardware bootstrapper invoked by the project installer.
- `asound.state` – Known-good ALSA mixer snapshot with AGC + HPF tuning.
- `respeaker-2mic-v2_0-overlay.dtbo` – Device Tree overlay for the TLV320AIC3x codec. *(Not committed – supply the production binary before running the installer.)*
- `snd-soc-tlv320aic3x-i2c.ko.tar.gz` – Prebuilt kernel module archive. *(Not committed – supply the production archive before running the installer.)*
- `kernel-6.8.0-1040/` – Offline kernel image and headers packages. *(Directory retained for drop-in .deb files; populate with the production packages before running the installer.)*

## Preparing the bundle

The repository omits the large binary deliverables listed above. Before provisioning hardware, copy the signed `.deb`, `.dtbo`, and `.tar.gz` artifacts into this directory using the exact filenames referenced by `install.sh`. See the release packaging notes for instructions on exporting the assets from the build pipeline.

The installer will abort if any asset is missing so failures are visible during staging.
