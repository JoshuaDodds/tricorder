#!/bin/bash

#sudo systemctl stop systemd-journald
sudo journalctl --rotate
sudo journalctl --vacuum-time=1s
sudo rm -rf /run/log/journal/*
#sudo systemctl start systemd-journald

rm -rf /apps/tricorder/recordings/*
rm -rf /apps/tricorder/tmp/*
