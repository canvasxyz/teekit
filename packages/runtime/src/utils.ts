export function generateUsername(): string {
  const randomNum = Math.floor(Math.random() * 1000000)
  return `user${randomNum.toString().padStart(6, "0")}`
}

export function getStoredUsername(): string {
  const stored = localStorage.getItem("chat-username")
  if (stored) {
    return stored
  }
  const newUsername = generateUsername()
  localStorage.setItem("chat-username", newUsername)
  return newUsername
}
