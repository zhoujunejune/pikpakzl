/* Only install/activate the app; NEVER cache sensitive API responses or HTML. */
self.addEventListener("install",event=>{event.waitUntil(self.skipWaiting());});
self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim());});
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!url.pathname.startsWith("/app/"))return;
  event.respondWith(fetch(event.request));
});
