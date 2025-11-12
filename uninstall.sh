#!/usr/bin/env sh

INSTALL_PATH=$(npm config get prefix)/bin/kettle

if test -f "$INSTALL_PATH"; then
    rm ${INSTALL_PATH}
    echo "Uninstalled $INSTALL_PATH"
else
    echo "No executable found at $INSTALL_PATH"
fi
