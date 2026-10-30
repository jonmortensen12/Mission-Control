/* Mission Control - how the phones and the television reach each other.

   The television is the host and every phone is a client, the same shape
   as Family Beatdown: PeerJS over WebRTC, a four-letter room code, the
   phones joining from a QR code. PeerJS's free broker only introduces the
   two ends; once connected, the game traffic goes device to device.

   `?local=1` swaps WebRTC for a BroadcastChannel. That only reaches other
   tabs of the same browser, which is exactly what the headless check
   (netcheck.mjs) and a laptop with a few tabs open need - no internet, no
   broker, the same messages. Both kinds of connection look the same to the
   game: {peer, send(obj), close(), on('open'|'data'|'close', fn)}. */
(function(root){
'use strict';

var PREFIX = 'mctl-';
var PEER_CDNS = ['https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
                 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'];
var STUN = [{urls: 'stun:stun.cloudflare.com:3478'}, {urls: 'stun:stun.l.google.com:19302'}];

/* The relay pass, from the Worker's /relay (see worker.js). Kept and reused
   while it has four hours left. A slow or missing pass never holds up a
   join: after 2.5 seconds the attempt goes ahead without it, which is
   exactly how it connects with no relay at all. */
var relayNone = false;
function peerOpts(cb){
  var done = false;
  function go(ice){
    if(done) return;
    done = true;
    cb({pingInterval: 4000, config: {iceServers: STUN.concat(ice || [])}});
  }
  if(relayNone || typeof fetch !== 'function' || !/^https?:$/.test(location.protocol)) return go(null);
  try {
    var kept = JSON.parse(localStorage.getItem('mctl_relay') || 'null');
    if(kept && kept.ice && kept.exp - Date.now() > 4 * 3600e3) return go(kept.ice);
  } catch(e){}
  setTimeout(function(){ go(null); }, 2500);
  fetch('relay', {cache: 'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(j && j.iceServers && j.iceServers.length){
        try { localStorage.setItem('mctl_relay', JSON.stringify({ice: j.iceServers, exp: j.exp})); } catch(e){}
        go(j.iceServers);
      } else { relayNone = true; go(null); }
    }, function(){ go(null); });
}

function isLocal(){ return /(^|[?&])local=1(&|$)/.test(location.search); }

function webrtcHere(){
  return typeof RTCPeerConnection !== 'undefined' || typeof webkitRTCPeerConnection !== 'undefined';
}

/* Two CDNs, so one being down is not the end of the evening. */
function loadPeer(cb){
  if(root.Peer) return cb(null);
  var i = 0;
  (function next(){
    if(i >= PEER_CDNS.length) return cb('Could not load the connection library. This needs internet.');
    var sc = document.createElement('script');
    sc.src = PEER_CDNS[i++];
    sc.crossOrigin = 'anonymous';
    sc.onload = function(){ cb(root.Peer ? null : 'This browser could not run the connection library.'); };
    sc.onerror = function(){ sc.remove(); next(); };
    document.head.appendChild(sc);
  })();
}

function codeGen(){
  var letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alikes
  var c = '';
  for(var i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return c;
}

function emitter(){
  var h = {};
  return {
    on: function(ev, fn){ (h[ev] = h[ev] || []).push(fn); },
    fire: function(ev, x){ (h[ev] || []).slice().forEach(function(fn){ try { fn(x); } catch(e){ console.error(e); } }); }
  };
}

/* ---------- BroadcastChannel stand-in ---------- */
function localConn(bc, me, other){
  var em = emitter(), open = true;
  return {
    peer: other, on: em.on, _fire: em.fire,
    send: function(d){ if(open) bc.postMessage({k: 'd', from: me, to: other, d: d}); },
    close: function(){
      if(!open) return;
      open = false;
      bc.postMessage({k: 'close', from: me, to: other});
      em.fire('close');
    },
    _closed: function(){ if(open){ open = false; em.fire('close'); } }
  };
}

function hostLocal(code, h){
  var bc = new BroadcastChannel(PREFIX + code), conns = {};
  bc.onmessage = function(ev){
    var m = ev.data;
    if(!m || (m.to && m.to !== 'host')) return;
    if(m.k === 'hello'){
      var c = localConn(bc, 'host', m.from);
      conns[m.from] = c;
      h.conn(c);
      bc.postMessage({k: 'welcome', from: 'host', to: m.from});
      c._fire('open');
    } else if(m.k === 'd' && conns[m.from]) conns[m.from]._fire('data', m.d);
    else if(m.k === 'close' && conns[m.from]){ conns[m.from]._closed(); delete conns[m.from]; }
  };
  setTimeout(function(){ h.open(); }, 0);
  return {destroy: function(){
    Object.keys(conns).forEach(function(k){ conns[k].close(); });
    bc.close();
  }};
}

function joinLocal(code, h){
  var bc = new BroadcastChannel(PREFIX + code);
  var me = 'p' + Math.random().toString(36).slice(2, 10), c = null;
  var timer = setTimeout(function(){
    if(!c){ bc.close(); h.error('peer-unavailable'); }
  }, 3000);
  bc.onmessage = function(ev){
    var m = ev.data;
    if(!m || m.to !== me) return;
    if(m.k === 'welcome' && !c){
      clearTimeout(timer);
      c = localConn(bc, me, 'host');
      h.open(c);
      c._fire('open');
    } else if(m.k === 'd' && c) c._fire('data', m.d);
    else if(m.k === 'close' && c) c._closed();
  };
  bc.postMessage({k: 'hello', from: me, to: 'host'});
  return {destroy: function(){ clearTimeout(timer); if(c) c.close(); bc.close(); }};
}

/* ---------- WebRTC, through PeerJS ---------- */
var FATAL = ['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable',
             'server-error', 'socket-error', 'socket-closed'];

function hostPeer(code, opts, h){
  var peer = new root.Peer(PREFIX + code, opts);
  var opened = false;
  var timer = setTimeout(function(){
    if(!opened){ try { peer.destroy(); } catch(e){} h.error('The room did not finish opening. Check this screen has internet.'); }
  }, 15000);
  peer.on('open', function(){ opened = true; clearTimeout(timer); h.open(); });
  peer.on('connection', function(conn){ h.conn(conn); });
  peer.on('error', function(err){
    var t = err && err.type;
    if(t === 'unavailable-id'){ clearTimeout(timer); try { peer.destroy(); } catch(e){} h.error('taken'); return; }
    // a phone asking for a room that has gone is not the room's problem
    if(FATAL.indexOf(t) >= 0){ clearTimeout(timer); try { peer.destroy(); } catch(e){} h.error('Connection problem (' + t + ').'); }
  });
  return {destroy: function(){ clearTimeout(timer); try { peer.destroy(); } catch(e){} }};
}

function joinPeer(code, opts, h){
  var peer = new root.Peer(opts), done = false;
  var timer = setTimeout(function(){ if(!done){ done = true; try { peer.destroy(); } catch(e){} h.error('timeout'); } }, 15000);
  peer.on('open', function(){
    var conn = peer.connect(PREFIX + code, {reliable: true});
    conn.on('open', function(){ if(done) return; done = true; clearTimeout(timer); h.open(conn); });
  });
  peer.on('error', function(err){
    if(done) return;
    done = true; clearTimeout(timer);
    try { peer.destroy(); } catch(e){}
    h.error((err && err.type) || 'unknown');
  });
  return {destroy: function(){ clearTimeout(timer); done = true; try { peer.destroy(); } catch(e){} }};
}

/* Open a room. h = {open(code), conn(conn), error(msg)}. A code already in
   use somewhere in the world gets a new one, quietly. */
function host(h){
  var code = codeGen();
  if(isLocal()) return hostLocal(code, {open: function(){ h.open(code); }, conn: h.conn, error: h.error});
  if(!webrtcHere()){ h.error('This browser has no WebRTC, which is what the phones connect over. Run the game on a laptop, phone or tablet and put that on the TV.'); return null; }
  var handle = {destroy: function(){ if(handle.inner) handle.inner.destroy(); }};
  loadPeer(function(err){
    if(err) return h.error(err);
    peerOpts(function(opts){
      (function attempt(){
        handle.inner = hostPeer(code, opts, {
          open: function(){ h.open(code); }, conn: h.conn,
          error: function(m){ if(m === 'taken'){ code = codeGen(); attempt(); } else h.error(m); }
        });
      })();
    });
  });
  return handle;
}

/* Join one. h = {open(conn), error(type)}. */
function join(code, h){
  if(isLocal()) return joinLocal(code, h);
  if(!webrtcHere()){ h.error('browser-incompatible'); return null; }
  var handle = {destroy: function(){ if(handle.inner) handle.inner.destroy(); }};
  loadPeer(function(err){
    if(err) return h.error('library');
    peerOpts(function(opts){ handle.inner = joinPeer(code, opts, h); });
  });
  return handle;
}

root.MCNet = {host: host, join: join, isLocal: isLocal, codeGen: codeGen, loadPeer: loadPeer};
})(window);
