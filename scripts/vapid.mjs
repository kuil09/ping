import webpush from "web-push";
// This command runs locally. Do not run it in CI where private keys would enter logs.
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
