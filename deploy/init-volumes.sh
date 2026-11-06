#!/bin/sh

set -eu

install -d -o 10001 -g 10001 \
    /data/media \
    /data/models \
    /data/beat
