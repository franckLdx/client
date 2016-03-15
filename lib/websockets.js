'use strict'

var EventEmitter = require('events').EventEmitter
var core = require('node-xmpp-core')
var Element = core.Element
var StreamParser = core.StreamParser
var Connection = core.Connection
var inherits = core.inherits
var WebSocket = require('faye-websocket') && require('faye-websocket').Client ? require('faye-websocket').Client : window.WebSocket
var debug = require('debug')('xmpp:client:websockets')

var INITIAL_RECONNECT_DELAY = 1e3
var MAX_RECONNECT_DELAY = 30e3

var NS_FRAMING = 'urn:ietf:params:xml:ns:xmpp-framing'

function resetHandlers(websocket) {
  websocket.onopen = undefined
  websocket.onmessage = undefined
  websocket.onclose = undefined
  websocket.onerror = undefined
}

function WSConnection (opts) {
  EventEmitter.call(this)

  this.url = opts.websocket.url
  this.jid = opts.jid
  this.xmlns = {}
  this.reconnecting = undefined; // Reconnection not in progress when undefined

  this.doConnect()
  this.setReconnect(opts)
}

inherits(WSConnection, EventEmitter)

WSConnection.prototype.maxStanzaSize = 65535
WSConnection.prototype.xmppVersion = '1.0'

WSConnection.prototype.setHandlers = function () {
  this.websocket.onopen = this.onopen.bind(this)
  this.websocket.onmessage = this.onmessage.bind(this)
  this.websocket.onclose = this.onclose.bind(this)
  this.websocket.onerror = this.onerror.bind(this)
}

WSConnection.prototype.doConnect = function() {
  this.websocket = new WebSocket(this.url, ['xmpp'])
  this.setHandlers()
}

WSConnection.prototype.setReconnect = function (opts) {
  this.reconnect = opts.reconnect || false; // False by default to keep legacy behavior
  if (!this.reconnect) {
      return
  }
  this.maxDelay = opts.maxDelay || MAX_RECONNECT_DELAY
  var reconnectDelay = opts.initialReconnectDelay || opts.reconnectDelay || INITIAL_RECONNECT_DELAY
  var self = this

  this.on('disconnect', function() {
    if (!self.reconnect) { // avoid reconnection when the socket is closing and when reconnection is not configured
      return
    }
    if (!self.reconnecting) {
      self.reconnecting = Date.now()
    }
    self.stopParser();
    resetHandlers(self.websocket)
    if (Date.now() - self.reconnecting > self.maxDelay) {
      self.reconnecting = undefined
      return
    }
    setTimeout(
      self.doConnect.bind(self),
      reconnectDelay
    )
  })
}

WSConnection.prototype.onopen = function () {
  this.startParser()
  if (!this.reconnecting) {
    this.emit('connected')
  } else {
    this.emit('connected')
    this.emit('reconnect')
    this.reconnecting = undefined
  }
}

WSConnection.prototype.startParser = function () {
  var self = this
  this.parser = new StreamParser.StreamParser(this.maxStanzaSize)

  this.parser.on('start', function (attrs) {
    self.streamAttrs = attrs
    /* We need those xmlns often, store them extra */
    self.streamNsAttrs = {}
    for (var k in attrs) {
      if ((k === 'xmlns') ||
        (k.substr(0, 6) === 'xmlns:')) {
        self.streamNsAttrs[k] = attrs[k]
      }
    }

    /* Notify in case we don't wait for <stream:features/>
       (Component or non-1.0 streams)
     */
    self.emit('streamStart', attrs)
  })
  this.parser.on('stanza', function (stanza) {
    // self.onStanza(self.addStreamNs(stanza))
    self.onStanza(stanza)
  })
  this.parser.on('error', this.onerror.bind(this))
  this.parser.on('end', function () {
    self.stopParser()
    self.end()
  })
}

WSConnection.prototype.stopParser = function () {
  /* No more events, please (may happen however) */
  if (this.parser) {
    /* Get GC'ed */
    delete this.parser
  }
}

WSConnection.prototype.onmessage = function (msg) {
  debug('ws msg <--', msg.data)
  if (msg && msg.data && this.parser) {
    this.parser.write(msg.data)
  }
}

WSConnection.prototype.onStanza = function (stanza) {
  if (stanza.is('error', Connection.NS_STREAM)) {
    /* TODO: extract error text */
    this.emit('error', stanza)
  } else {
    this.emit('stanza', stanza)
  }
}

WSConnection.prototype.startStream = function () {
  var attrs = {}
  for (var k in this.xmlns) {
    if (this.xmlns.hasOwnProperty(k)) {
      if (!k) {
        attrs.xmlns = this.xmlns[k]
      } else {
        attrs['xmlns:' + k] = this.xmlns[k]
      }
    }
  }
  if (this.xmppVersion) attrs.version = this.xmppVersion
  if (this.streamTo) attrs.to = this.streamTo
  if (this.jid) attrs.to = this.jid.domain
  attrs['xmlns:stream'] = Connection.NS_STREAM

  this.send(new Element('open', attrs))

  this.streamOpened = true
}

WSConnection.prototype.send = function (stanza) {
  if (stanza.root) stanza = stanza.root()
  stanza = stanza.toString()
  debug('ws send -->', stanza)
  this.websocket.send(stanza)
}

WSConnection.prototype.onclose = function () {
  this.emit('disconnect')
  if (!this.reconnecting) {
    this.emit('close')
  }
}

WSConnection.prototype.end = function () {
  this.reconnect = false
  this.send(new Element('close', {xmlns: NS_FRAMING}))
  this.emit('disconnect')
  this.emit('end')
  if (this.websocket) this.websocket.close()
}

WSConnection.prototype.onerror = function (e) {
  this.emit('error', e)
}

module.exports = WSConnection
