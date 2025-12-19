# Setup script for teekit image builder machines.

sudo apt update
sudo apt install -y build-essential qemu-utils qemu-system-x86

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install v22
nvm alias default v22

# Install homebrew
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> ~/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

echo 'Installed nvm and homebrew, use `source ~/.bashrc` to update your command line.'

# Install lima
brew install lima

# Install dependencies
npm install

# Install coding assistants
npm install -g @anthropic-ai/claude-code

# Install image builder dependencies
FORCE_LIMA=1 NONINTERACTIVE=1 packages/images/scripts/setup_deps.sh
