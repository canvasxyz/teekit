#!/usr/bin/env sh

INSTALL_PATH=$(npm config get prefix)/bin/kettle

echo "Installing the local development build of the kettle CLI to /usr/bin/dev."

if test -f "$INSTALL_PATH"; then
    read -p "Already installed. Overwrite any past install? [y/N] " -n 1 -r
    if [[ $REPLY =~ ^[Yy]$ ]]
    then
        # Overwrite any past install
        unlink ${$INSTALL_PATH}
        echo "#!/usr/bin/env sh" > ${INSTALL_PATH}
    else
        echo
        echo "Aborting, ok!"
        exit 1
    fi
else
    # Create a new install
    touch ${INSTALL_PATH}
    echo "#!/usr/bin/env sh" >> ${INSTALL_PATH}
fi
echo "node ${PWD}/packages/kettle/server/lib/launcher.js \$@" >> ${INSTALL_PATH}
chmod +x ${INSTALL_PATH}
echo
echo "Done!"
