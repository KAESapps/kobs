console.info("Loading kobs")

// const log = console.log
const log = () => {}
const last = require("lodash/last")
const difference = function difference(setA, setB) {
  setB.forEach((elm) => setA.delete(elm))
  return setA
}

let autorunsNeedingRun = new Set()
let maybeUnobserved = new Set()
let currentlyRunningStack = []
let transactionLevel = 0

exports.observable = (arg, name) => {
  if (typeof arg === "function") {
    const obs = new exports.Computed(arg, null, null, name)
    return () => obs.get()
  } else {
    const obs = new exports.Obs(arg, null, null, name)
    return function (arg) {
      return arguments.length ? obs.set(arg) : obs.get()
    }
  }
}

exports.Obs = function (initValue, onUnobserved, onObserved, name) {
  this.name = name
  this.value = initValue
  this.observers = new Set()
  this.onUnobserved = onUnobserved
}
Object.assign(exports.Obs.prototype, {
  set: function (newValue) {
    //TODO: mettre en commun avec le code de "transaction"
    transactionLevel++
    this.value = newValue
    log("source changed", this.name)
    this.observers.forEach((observer) => observer.markStale())
    transactionLevel--
    if (transactionLevel === 0) {
      autorunsNeedingRun.forEach((autorun) =>
        autorun.compute(autorun.unobserve)
      )
      autorunsNeedingRun = new Set()
      maybeUnobserved.forEach((obs) => obs.notifyIfUnobserved())
      maybeUnobserved = new Set()
    }
  },
  get: function () {
    const currentlyRunning = last(currentlyRunningStack)
    if (currentlyRunning && !currentlyRunning.deps.has(this)) {
      currentlyRunning.deps.add(this)
      this.observers.add(currentlyRunning)
      log("adding deps from source", this.name, "to", currentlyRunning.name)
    }
    return this.value
  },
  removeObserver: function (observer) {
    log("removing deps from source", this.name, "to", observer.name)
    this.observers.delete(observer)
    log("observers of", this.name, this.observers.size, this.observers)
    if (this.observers.size === 0) maybeUnobserved.add(this)
  },
  notifyIfUnobserved: function () {
    // after running all autorun, if this.observers is still empty, we can notify that we are unobserved
    if (this.onUnobserved && this.observers.size === 0) {
      log("notify unobserved", this.name)
      this.onUnobserved()
    }
  },
})

exports.Computed = function (fn, onUnobserved, onObserved, name) {
  this.name = name
  this.stale = true
  this.observers = new Set()
  this.deps = new Set()
  this.fn = fn
}
Object.assign(exports.Computed.prototype, {
  markStale: function () {
    if (this.stale) return // pas besoin de recommencer si on a déjà été marqué stale
    this.stale = true
    log(this.name, "computed marked stale")
    this.observers.forEach((observer) => observer.markStale())
  },
  compute: function () {
    log("computing", this.name)
    this.oldDeps = this.deps
    this.deps = new Set()
    currentlyRunningStack.push(this)
    this.value = this.fn()
    currentlyRunningStack.pop()
    this.stale = false
    difference(this.oldDeps, this.deps).forEach((dep) =>
      dep.removeObserver(this)
    )
  },
  removeObserver: function (observer) {
    log("removing deps from computed", this.name, "to", observer.name)
    this.observers.delete(observer)
    if (this.observers.size === 0) {
      this.deps.forEach((dep) => dep.removeObserver(this))
      this.stale = true // déclenche le recomputing lors de la prochaine observation
    }
  },
  get: function () {
    const currentlyRunning = last(currentlyRunningStack)
    if (currentlyRunning && !currentlyRunning.deps.has(this)) {
      currentlyRunning.deps.add(this)
      this.observers.add(currentlyRunning)
      log("adding deps from computed", this.name, "to", currentlyRunning.name)
    }
    if (this.stale) this.compute()
    return this.value
  },
})

const autorun = (exports.autorun = (fn, name, after) => {
  const me = {
    name,
    deps: new Set(),
    markStale: () => {
      log("autorun marked stale", name)
      autorunsNeedingRun.add(me)
    },
  }
  me.unobserve = () => {
    log("cancelling", name)
    if (last(currentlyRunningStack) === me) {
      me.canceledDuringRun = true
      log("canceling during run", name)
    } else {
      me.deps.forEach((dep) => dep.removeObserver(me))
      autorunsNeedingRun.delete(me)
      me.deps = new Set()
      maybeUnobserved.forEach((obs) => obs.notifyIfUnobserved())
      maybeUnobserved = new Set()
      log("cancelled", name)
    }
  }
  me.compute = (cancel) => {
    log("computing autorun", name)
    me.oldDeps = me.deps
    me.deps = new Set()
    currentlyRunningStack.push(me)
    fn(cancel)
    currentlyRunningStack.pop()
    if (me.canceledDuringRun) {
      // si on a été annulé en cours de run, il faut vider la liste des dépendances qui se sont auto enregistrées
      me.deps.forEach((dep) => dep.removeObserver(me))
      autorunsNeedingRun.delete(me)
      me.deps = new Set()
      me.canceledDuringRun = false
      log("autorun cancelled during run", name)
    }
    difference(me.oldDeps, me.deps).forEach((dep) => dep.removeObserver(me))
    if (after) after() // éxécuté en synchrone mais sans tracking des dépendances
  }
  me.compute(me.unobserve)
  return me.unobserve
})

exports.transaction = (fn) => {
  transactionLevel++
  fn()
  transactionLevel--
  if (transactionLevel === 0) {
    autorunsNeedingRun.forEach((autorun) => autorun.compute(autorun.unobserve))
    autorunsNeedingRun = new Set()
    maybeUnobserved.forEach((obs) => obs.notifyIfUnobserved())
    maybeUnobserved = new Set()
  }
}

// permet d'éxécuter une fonction en continu dès que la condition est vraie
// si la fonction retourne un promise, la prochaine itération attend qu'il soit terminé (résolu ou rejeté)
exports.repeatWhen = (canRun, cb, name) => {
  let repeat = true
  const autorunFn = (cancel) => {
    const canRunValue = canRun()
    if (!canRunValue) return
    console.log("repeatWhen condition truthy", { name, canRunValue })
    cancel() // on se désabonne avant d'exécuter le callback pour être sûr de ne déclencher qu'un run à la fois
    // peut-être pas très logique de renvoyer la valeur du canRun dans le cb mais c'est pratique quand on veut exécuter le cb avec le résultat (truthy) du canRun
    Promise.resolve(cb(canRunValue)).then(() => {
      if (!repeat) return console.log("repeatWhen canceled", name)
      autorun(autorunFn, "repeatWhenAgain") // puis on se réabonne après le run (en asynchrone), pour déclencher le suivant
    })
  }
  autorun(autorunFn, "repeatWhenInit")
  return () => (repeat = false)
}

exports.observeSync = function (obs, cb) {
  let oldVal, newVal
  return autorun(
    () => {
      newVal = obs()
    },
    null,
    () => {
      cb(newVal, oldVal)
      oldVal = newVal
    }
  )
}
// asynchronous version of observe
exports.observe = function (obs, cb) {
  return () =>
    autorun(function () {
      const v = obs()
      setTimeout(() => cb(v))
    })
}

// persiste la valeur dans le local storage
// initValue n'est utilisée que si l'observbale n'a jamais été persisté
exports.persistedObservable = function (name, initValue) {
  const json = window.localStorage.getItem(name)
  const value = json ? JSON.parse(json) : initValue
  const obs = new exports.Obs(value, null, null, name)
  const setAndPersist = (newValue) => {
    window.localStorage.setItem(name, JSON.stringify(newValue))
    obs.set(newValue)
  }
  return function (arg) {
    return arguments.length ? setAndPersist(arg) : obs.get()
  }
}
