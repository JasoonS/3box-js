const KeyValueStore = require('./keyValueStore')
const Thread = require('./thread')
const { sha256Multihash, throwIfUndefined, throwIfNotEqualLenArrays } = require('./utils')
const OrbitDBAddress = require('orbit-db/src/orbit-db-address')

const ENC_BLOCK_SIZE = 24
const nameToSpaceName = name => `3box.space.${name}.keyvalue`
const namesTothreadName = (spaceName, threadName) => `3box.thread.${spaceName}.${threadName}`

class Space {
  /**
   * Please use **box.openSpace** to get the instance of this class
   */
  constructor (name, threeId, orbitdb, rootStore, ensureConnected) {
    this._name = name
    this._3id = threeId
    this._ensureConnected = ensureConnected
    this._store = new KeyValueStore(orbitdb, nameToSpaceName(this._name), this._ensureConnected, this._3id)
    this._orbitdb = orbitdb
    this._activeThreads = {}
    this._rootStore = rootStore
    /**
     * @property {KeyValueStore} public         access the profile store of the space
     */
    this.public = null
    /**
     * @property {KeyValueStore} private        access the private store of the space
     */
    this.private = null
  }

  async open (opts = {}) {
    if (!this._store._db) {
      // store is not loaded opened yet
      const consentNeeded = await this._3id.initKeyringByName(this._name)
      if (opts.consentCallback) opts.consentCallback(consentNeeded, this._name)
      const spaceAddress = await this._store._load()

      const entries = await this._rootStore.iterator({ limit: -1 }).collect()
      if (!entries.find(entry => entry.payload.value.odbAddress.indexOf(nameToSpaceName(this._name)) !== -1)) {
        this._rootStore.add({ odbAddress: spaceAddress })
      }
      const hasNumEntries = opts.numEntriesMessages && opts.numEntriesMessages[spaceAddress]
      const numEntries = hasNumEntries ? opts.numEntriesMessages[spaceAddress].numEntries : undefined
      const syncSpace = async () => {
        await this._store._sync(numEntries)
        if (opts.onSyncDone) opts.onSyncDone()
      }
      this._syncSpacePromise = syncSpace()
      this.public = publicStoreReducer(this._store)
      this.private = privateStoreReducer(this._store, this._3id.getKeyringBySpaceName(nameToSpaceName(this._name)))
      this._ensureDIDPublished()
    }
  }

  /**
   * Join a thread. Use this to start receiving updates from, and to post in threads
   *
   * @param     {String}    name                    The name or full address of the thread
   * @param     {Object}    opts                    Optional parameters
   * @param     {Boolean}   opts.membersOnly        join a members only thread, which only members can post in, ignores if joined by address
   * @param     {String}    opts.rootMod            the rootMod, known as first moderator of a thread, by default user is moderator, ignored if joined by address
   * @param     {Boolean}   opts.noAutoSub          Disable auto subscription to the thread when posting to it (default false)
   *
   * @return    {Thread}                            An instance of the thread class for the joined thread
   */
  async joinThread (name, opts = {}) {
    if (this._activeThreads[name]) return this._activeThreads[name]
    const subscribeFn = opts.noAutoSub ? () => {} : this.subscribeThread.bind(this)
    if (!opts.rootMod) opts.rootMod = this._3id.getSubDID(this._name)
    const thread = new Thread(this._orbitdb, namesTothreadName(this._name, name), this._3id, opts.membersOnly, opts.rootMod, subscribeFn, this._ensureConnected)
    if (OrbitDBAddress.isValid(name)) {
      const addressSpace = name.split('.')[2]
      if (addressSpace !== this._name) throw new Error('joinThread: attempting to open thread from different space, must open within same space')
      await thread._load(name)
    } else {
      await thread._load()
    }
    this._activeThreads[name] = thread
    return thread
  }

  /**
   * Subscribe to the given thread, if not already subscribed
   *
   * @param     {String}    address           The address of the thread
   * @param     {Object}    config            configuration and thread meta data
   * @param     {String}    opts.name         Name of thread
   * @param     {String}    opts.rootMod      DID of the root moderator
   * @param     {String}    opts.members      Boolean string, true if a members only thread
   */
  async subscribeThread (address, config = {}) {
    if (!OrbitDBAddress.isValid(address)) throw new Error('subscribeThread: must subscribe to valid thread/orbitdb address')
    const threadKey = `thread-${address}`
    await this._syncSpacePromise
    if (!(await this.public.get(threadKey))) {
      await this.public.set(threadKey, Object.assign({}, config, { address }))
    }
  }

  /**
   * Unsubscribe from the given thread, if subscribed
   *
   * @param     {String}    address     The address of the thread
   */
  async unsubscribeThread (address) {
    const threadKey = `thread-${address}`
    if (await this.public.get(threadKey)) {
      await this.public.remove(threadKey)
    }
  }

  /**
   * Get a list of all the threads subscribed to in this space
   *
   * @return    {Array<Objects>}    A list of thread objects as { address, rootMod, members, name}
   */
  async subscribedThreads () {
    const allEntries = await this.public.all()
    return Object.keys(allEntries).reduce((threads, key) => {
      if (key.startsWith('thread')) {
        // ignores experimental threads (v1)
        const address = key.split('thread-')[1]
        if (OrbitDBAddress.isValid(address)) {
          threads.push(allEntries[key])
        }
      }
      return threads
    }, [])
  }

  async _ensureDIDPublished () {
    // Ensure we self-published our did
    if (!(await this.public.get('proof_did'))) {
      await this._syncSpacePromise
      // we can just sign an empty JWT as a proof that we own this DID
      await this.public.set('proof_did', await this._3id.signJWT({}, { space: this._name }), { noLink: true })
    }
  }
}

module.exports = Space

const publicStoreReducer = (store) => {
  const PREFIX = 'pub_'
  return {
    get: async (key, opts = {}) => store.get(PREFIX + key, opts),
    getMetadata: async key => store.getMetadata(PREFIX + key),
    set: async (key, value) => {
      throwIfUndefined(key, 'key')
      return store.set(PREFIX + key, value)
    },
    setMultiple: async (keys, values) => {
      throwIfNotEqualLenArrays(keys, values)
      const prefixedKeys = keys.map(key => PREFIX + key)
      return store.setMultiple(prefixedKeys, values)
    },
    remove: async key => {
      throwIfUndefined(key, 'key')
      return store.remove(PREFIX + key)
    },
    get log () {
      return store.log.reduce((newLog, entry) => {
        if (entry.key.startsWith(PREFIX)) {
          entry.key = entry.key.slice(4)
          newLog.push(entry)
        }
        return newLog
      }, [])
    },
    all: async (opts) => {
      const entries = await store.all(opts)
      return Object.keys(entries).reduce((newAll, key) => {
        if (key.startsWith(PREFIX)) {
          newAll[key.slice(4)] = entries[key]
        }
        return newAll
      }, {})
    }
  }
}

const privateStoreReducer = (store, keyring) => {
  const PREFIX = 'priv_'
  const SALT = keyring.getDBSalt()
  const dbKey = key => {
    throwIfUndefined(key, 'key')
    return PREFIX + sha256Multihash(SALT + key)
  }
  const pad = (val, blockSize = ENC_BLOCK_SIZE) => {
    const blockDiff = (blockSize - (val.length % blockSize)) % blockSize
    return `${val}${'\0'.repeat(blockDiff)}`
  }
  const unpad = padded => padded.replace(/\0+$/, '')
  const encryptEntry = entry => keyring.symEncrypt(pad(JSON.stringify(entry)))
  const decryptEntry = ({ ciphertext, nonce }) => {
    return JSON.parse(unpad(keyring.symDecrypt(ciphertext, nonce)))
  }
  return {
    get: async (key, opts = {}) => {
      const entry = await store.get(dbKey(key), opts)

      if (!entry) {
        return null
      }

      if (opts.metadata) {
        return {
          ...entry,
          value: decryptEntry(entry.value).value
        }
      }

      return decryptEntry(entry).value
    },
    getMetadata: async key => store.getMetadata(dbKey(key)),
    set: async (key, value) => store.set(dbKey(key), encryptEntry({ key, value })),
    setMultiple: async (keys, values) => {
      throwIfNotEqualLenArrays(keys, values)
      const dbKeys = keys.map(dbKey)
      const encryptedEntries = values.map((value, index) => encryptEntry({ key: keys[index], value }))
      return store.setMultiple(dbKeys, encryptedEntries)
    },
    remove: async key => store.remove(dbKey(key)),
    get log () {
      return store.log.reduce((newLog, entry) => {
        if (entry.key.startsWith(PREFIX)) {
          const decEntry = decryptEntry(entry.value)
          entry.key = decEntry.key
          entry.value = decEntry.value
          newLog.push(entry)
        }
        return newLog
      }, [])
    },
    all: async (opts = {}) => {
      const entries = await store.all(opts)
      return Object.keys(entries).reduce((newAll, key) => {
        if (key.startsWith(PREFIX)) {
          const entry = entries[key]

          if (opts.metadata) {
            const decEntry = decryptEntry(entry.value)
            newAll[decEntry.key] = {
              ...entry,
              value: decEntry.value
            }
          } else {
            const decEntry = decryptEntry(entry)
            newAll[decEntry.key] = decEntry.value
          }
        }
        return newAll
      }, {})
    }
  }
}
