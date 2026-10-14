#!/bin/bash

export $(xargs < ../../.env)
eas build --platform ios --profile development-simulator --non-interactive --local --output=kites.tar.gz --wait
[ -f kites.tar.gz ] &&  eas build:run -p ios --path=kites.tar.gz