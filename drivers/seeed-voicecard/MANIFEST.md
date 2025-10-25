# Seeed Voicecard Asset Bundle

This directory contains the resources required to provision the Seeed ReSpeaker 2-Mic Pi HAT v2.0 on Ubuntu 24.04 LTS with the Raspberry Pi `6.8.0-1040-raspi` kernel.

## Contents

- `install.sh` – Hardware bootstrapper invoked by the project installer.
- `asound.state` – Known-good ALSA mixer snapshot with HPF tuning L+R proper routing, capsule on and bias set correctly, capture gain set to a good starting level.
- `respeaker-2mic-v2_0-overlay.dtbo` – Device Tree overlay for the TLV320AIC3x codec. *(Not committed – supply the production binary before running the installer.)*
- `snd-soc-tlv320aic3x-i2c.ko.tar.gz` – Prebuilt kernel module archive. *(Not committed – supply the production archive before running the installer.)*
- `kernel-6.8.0-1040/` – Offline kernel image, modules, and headers packages. *(Directory retained for drop-in .deb files; populate with the production packages before running the installer.)*
