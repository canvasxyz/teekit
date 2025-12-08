# ~/.profile: executed by Bourne-compatible login shells.
FIRST_LOGIN_MARKER="/var/lib/devtools-password-changed"

if [ ! -f "$FIRST_LOGIN_MARKER" ]; then
    echo
    echo -e "\033[1;31m╔═════════════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[1;31m║                                                                     ║\033[0m"
    echo -e "\033[1;31m║                 DEVTOOLS IMAGE - NOT FOR PRODUCTION                 ║\033[0m"
    echo -e "\033[1;31m║                                                                     ║\033[0m"
    echo -e "\033[1;31m║   This image has SSH enabled with a default root password.          ║\033[0m"
    echo -e "\033[1;31m║   You should change the password immediately.                       ║\033[0m"
    echo -e "\033[1;31m║                                                                     ║\033[0m"
    echo -e "\033[1;31m╚═════════════════════════════════════════════════════════════════════╝\033[0m"
    echo
    echo "Please enter a new password for root:"
    if passwd; then
        # Create marker file to prevent prompt on future logins
        mkdir -p "$(dirname "$FIRST_LOGIN_MARKER")"
        touch "$FIRST_LOGIN_MARKER"
        echo
        echo -e "\033[1;32mPassword changed successfully.\033[0m"
    else
        echo
        echo -e "\033[1;31mPassword change failed. You can run 'passwd' manually later.\033[0m"
    fi
    echo
fi

# Standard profile settings
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/.local/bin" ] ; then
    PATH="$HOME/.local/bin:$PATH"
fi
