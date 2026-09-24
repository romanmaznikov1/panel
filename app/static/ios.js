/* ПЛЯСКИ — «характер» интерфейса: пружины, жесты, отклик на нажатие.
   Загружается перед app.js и кладёт всё в глобальный UI.

   Идея одна: на телефоне интерфейс должен вести себя как физический предмет.
   Это значит — отвечать в момент касания, ехать за пальцем один в один,
   подхватывать скорость броска и позволять себя перехватить на полпути.
   Обычные CSS-переходы этого не умеют: у них фиксированная длительность,
   и схваченное на лету окно сначала доедет, куда собиралось, и только потом
   передумает. Поэтому всё, чего касается палец, двигают пружины. */

(function () {
  "use strict";

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const coarse = matchMedia("(pointer: coarse)");
  const phone = matchMedia("(max-width: 820px)");

  /* --- пружина ----------------------------------------------------------

     Параметры — не «масса/жёсткость/затухание», а те два, которыми думают
     дизайнеры Apple:
       damping  — 1.0 доезжает без отскока, меньше 1.0 проскакивает и качается;
       response — за сколько секунд значение практически доходит до цели.
     Длительности у пружины нет: она просто всё время едет к текущей цели,
     а цель можно менять в любой момент — скорость при этом сохраняется,
     поэтому разворот получается без «стены». */

  const ticker = { live: new Set(), raf: 0, last: 0 };

  function tick(now) {
    const dt = Math.min((now - ticker.last) / 1000, 0.064);
    ticker.last = now;
    ticker.live.forEach((spring) => spring._step(dt));
    ticker.raf = ticker.live.size ? requestAnimationFrame(tick) : 0;
  }

  function wake(spring) {
    ticker.live.add(spring);
    if (!ticker.raf) {
      ticker.last = performance.now();
      ticker.raf = requestAnimationFrame(tick);
    }
  }

  class Spring {
    constructor(options) {
      const o = options || {};
      this.value = o.from || 0;
      this.target = o.to !== undefined ? o.to : this.value;
      this.velocity = o.velocity || 0;
      this.damping = o.damping !== undefined ? o.damping : 1;
      this.response = o.response || 0.4;
      this.restDelta = o.restDelta !== undefined ? o.restDelta : 0.4;
      this.restSpeed = o.restSpeed !== undefined ? o.restSpeed : 14;
      this.onUpdate = o.onUpdate || null;
      this.onRest = o.onRest || null;
    }

    /* Новая цель. Скорость не обнуляем — она и есть «память» о движении,
       из-за которой разворот жеста выглядит продолжением, а не новым
       мультиком с нуля. */
    to(target, options) {
      const o = options || {};
      this.target = target;
      if (o.velocity !== undefined) this.velocity = o.velocity;
      if (o.damping !== undefined) this.damping = o.damping;
      if (o.response !== undefined) this.response = o.response;
      if (o.onRest !== undefined) this.onRest = o.onRest;
      // При «меньше движения» никаких полётов — сразу конечное состояние.
      if (reduceMotion.matches) {
        this.value = target;
        this.velocity = 0;
        if (this.onUpdate) this.onUpdate(this.value, this);
        this._rest();
        return this;
      }
      wake(this);
      return this;
    }

    // Поставить значение мгновенно (например, перед показом окна).
    set(value, velocity) {
      this.value = value;
      this.target = value;
      this.velocity = velocity || 0;
      if (this.onUpdate) this.onUpdate(this.value, this);
      return this;
    }

    stop() {
      ticker.live.delete(this);
      this.target = this.value;
      this.velocity = 0;
      return this;
    }

    _rest() {
      ticker.live.delete(this);
      const done = this.onRest;
      this.onRest = null;
      if (done) done(this);
    }

    _step(dt) {
      const w = (2 * Math.PI) / this.response; // собственная частота
      const z = this.damping;
      // Мелкие шаги: на медленном кадре один большой шаг «взрывает» пружину.
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let i = 0; i < steps; i += 1) {
        const a = -w * w * (this.value - this.target) - 2 * z * w * this.velocity;
        this.velocity += a * h;
        this.value += this.velocity * h;
      }
      if (this.onUpdate) this.onUpdate(this.value, this);
      if (Math.abs(this.value - this.target) < this.restDelta && Math.abs(this.velocity) < this.restSpeed) {
        this.value = this.target;
        this.velocity = 0;
        if (this.onUpdate) this.onUpdate(this.value, this);
        this._rest();
      }
    }
  }

  /* Куда доедет брошенное. Это та же формула, по которой тормозит инерционная
     прокрутка: решение принимаем не по точке отпускания, а по точке, в которую
     жест целился. Поэтому короткий резкий щелчок закрывает окно, а медленное
     перетаскивание на то же расстояние — нет. */
  function project(velocity, deceleration) {
    const d = deceleration || 0.998;
    return ((velocity / 1000) * d) / (1 - d);
  }

  /* Сопротивление на границе: чем дальше тянут за край, тем меньше идёт.
     Жёсткий упор читается как «зависло», плавное сопротивление — как
     «работает, но дальше ничего нет». */
  function rubberband(overshoot, dimension, constant) {
    const c = constant || 0.55;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  // Короткий отклик там, где что-то защёлкнулось. Где не поддерживается —
  // просто ничего не делает (Safari на iPhone как раз из таких).
  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms || 8);
    } catch (e) {
      /* не страшно */
    }
  }

  /* --- отклик на нажатие --------------------------------------------------

     Подсветка должна появляться в момент касания, а не после отпускания:
     как только между пальцем и реакцией появляется задержка, ощущение
     прямого управления рассыпается. И наоборот — если увести палец с кнопки,
     нажатие должно отмениться. */

  const PRESSABLE =
    ".btn, .ghost-btn, .icon-btn, .link-btn, .seg-btn, .nav__item, .segmented button, .tab," +
    " .list-row:not(.list-row--static), .menu-item, .daychip, .session__head, .date-btn, .today-row," +
    " tbody tr.clickable, .expiring__row[data-student-id], .direction-picker__summary, .sheet-grabber";

  let pressed = null;
  let pressStart = null;

  function releasePress() {
    if (pressed) pressed.classList.remove("is-pressed");
    pressed = null;
    pressStart = null;
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      // Касание может прийти не по элементу (полоса прокрутки, сам документ) —
      // тогда искать по нему нечего.
      if (!event.target || typeof event.target.closest !== "function") return;
      const target = event.target.closest(PRESSABLE);
      if (!target || target.disabled) return;
      releasePress();
      pressed = target;
      pressStart = { x: event.clientX, y: event.clientY };
      target.classList.add("is-pressed");
    },
    true
  );

  // Увели палец дальше 10 px — это уже не нажатие, а прокрутка или перетаскивание.
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!pressed || !pressStart) return;
      if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) releasePress();
    },
    true
  );

  ["pointerup", "pointercancel", "blur", "contextmenu"].forEach((name) =>
    document.addEventListener(name, releasePress, true)
  );
  addEventListener("scroll", releasePress, true);

  /* --- модальные окна и «шторки» -----------------------------------------

     На широком экране это окно: появляется, чуть подрастая, и так же уходит.
     На телефоне — шторка снизу, за которую можно взяться и стянуть вниз.
     Всё время, пока её тянут, она идёт ровно за пальцем, затемнение фона
     светлеет вместе с ней, а выше верхней точки она упирается мягко. */

  const sheets = new WeakMap();

  function isPhone() {
    return phone.matches;
  }

  function sheetHeight(card) {
    return Math.max(card.offsetHeight, 1);
  }

  function makeController(overlay, card) {
    const state = {
      overlay,
      card,
      dragging: false,
      pointerId: null,
      history: [],
      startY: 0,
      startValue: 0,
      committed: false,
      dismissing: false,
      spring: null,
      mode: isPhone() ? "sheet" : "modal",
    };

    const applySheet = (y) => {
      const h = sheetHeight(card);
      card.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
      const p = Math.max(0, Math.min(1, 1 - y / h));
      overlay.style.setProperty("--scrim", p.toFixed(3));
    };

    const applyModal = (p) => {
      const scale = 0.94 + 0.06 * p;
      card.style.transform = `translate3d(0, ${((1 - p) * 12).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
      card.style.opacity = p.toFixed(3);
      overlay.style.setProperty("--scrim", Math.max(0, Math.min(1, p)).toFixed(3));
    };

    state.spring =
      state.mode === "sheet"
        ? new Spring({ damping: 0.82, response: 0.35, restDelta: 0.4, restSpeed: 14, onUpdate: applySheet })
        : new Spring({ damping: 1, response: 0.3, restDelta: 0.004, restSpeed: 0.05, onUpdate: applyModal });

    state.apply = state.mode === "sheet" ? applySheet : applyModal;
    return state;
  }

  function present(overlay, options) {
    const card = overlay.firstElementChild;
    if (!card) return;
    card.classList.add("ui-sheet");

    const state = makeController(overlay, card);
    state.onRequestClose = (options && options.onClose) || null;
    sheets.set(overlay, state);

    if (state.mode === "sheet") {
      addGrabber(card);
      attachDrag(state);
      // Высоту знаем только после вёрстки, поэтому сначала измеряем.
      const h = sheetHeight(card);
      state.spring.set(h);
      state.spring.to(0, { damping: 0.82, response: 0.35 });
    } else {
      state.spring.set(0);
      state.spring.to(1, { damping: 1, response: 0.28 });
    }
  }

  function dismiss(overlay, done, options) {
    const state = sheets.get(overlay);
    if (!state) {
      if (done) done();
      return;
    }
    if (state.dismissing) return;
    state.dismissing = true;
    const o = options || {};

    const finish = () => {
      sheets.delete(overlay);
      overlay.style.removeProperty("--scrim");
      const card = state.card;
      if (card) {
        card.style.transform = "";
        card.style.opacity = "";
      }
      if (done) done();
    };

    if (state.mode === "sheet") {
      // Уходит туда же, откуда пришла, и с той скоростью, с какой её толкнули.
      state.spring.to(sheetHeight(state.card), {
        damping: 1,
        response: 0.3,
        velocity: o.velocity,
        onRest: finish,
      });
    } else {
      state.spring.to(0, { damping: 1, response: 0.22, onRest: finish });
    }
  }

  // Новое окно поверх уезжающего: доводить старое незачем, просто убираем.
  function cancelDismiss(overlay) {
    const state = sheets.get(overlay);
    if (!state) return;
    state.spring.stop();
    state.spring.onRest = null;
    sheets.delete(overlay);
    overlay.style.removeProperty("--scrim");
  }

  function addGrabber(card) {
    if (card.querySelector(".sheet-grabber")) return;
    const grabber = document.createElement("div");
    grabber.className = "sheet-grabber";
    grabber.setAttribute("aria-hidden", "true");
    card.prepend(grabber);
  }

  /* Тянуть можно за «язычок» и за шапку окна — то есть за те места, где
     заведомо нечего прокручивать. Внутри полей и списков палец должен
     по-прежнему прокручивать содержимое, а не утаскивать шторку. */
  function attachDrag(state) {
    const card = state.card;

    const handleFor = (target) => {
      if (!target) return null;
      if (target.closest(".sheet-grabber")) return true;
      const head = target.closest(".modal__head");
      if (head && !target.closest("button, input, select, textarea, a")) return true;
      return false;
    };

    card.addEventListener("pointerdown", (event) => {
      if (state.dismissing || !handleFor(event.target)) return;
      if (event.button !== undefined && event.button !== 0) return;

      // Перехват на лету: окно ещё едет — забираем его из пружины как есть,
      // с той позиции, где оно сейчас нарисовано, без скачка.
      state.spring.stop();
      state.dragging = true;
      state.committed = false;
      state.pointerId = event.pointerId;
      state.startY = event.clientY;
      state.startValue = state.spring.value;
      state.history = [{ y: event.clientY, t: performance.now() }];
      try {
        card.setPointerCapture(event.pointerId);
      } catch (e) {
        /* мышь без захвата — тоже нормально */
      }
    });

    card.addEventListener("pointermove", (event) => {
      if (!state.dragging || event.pointerId !== state.pointerId) return;
      const dy = event.clientY - state.startY;

      // 10 px запаса: иначе обычный тап по шапке дёргает шторку.
      if (!state.committed) {
        if (Math.abs(dy) < 10) return;
        state.committed = true;
        card.classList.add("is-dragging");
      }
      event.preventDefault();

      const h = sheetHeight(card);
      let y = state.startValue + dy;
      if (y < 0) y = -rubberband(-y, h); // выше верхней точки — мягкое сопротивление
      state.spring.set(y);

      state.history.push({ y: event.clientY, t: performance.now() });
      if (state.history.length > 6) state.history.shift();
    });

    const end = (event) => {
      if (!state.dragging || event.pointerId !== state.pointerId) return;
      state.dragging = false;
      card.classList.remove("is-dragging");
      try {
        card.releasePointerCapture(event.pointerId);
      } catch (e) {
        /* уже отпущено */
      }
      if (!state.committed) return;

      // Скорость берём по нескольким последним точкам, а не по двум соседним:
      // одна случайная дрожащая выборка иначе решает судьбу окна.
      const now = performance.now();
      const first = state.history[0] || { y: event.clientY, t: now };
      const dt = Math.max((now - first.t) / 1000, 0.016);
      const velocity = (event.clientY - first.y) / dt;

      const h = sheetHeight(card);
      const y = state.spring.value;
      const projected = y + project(velocity);

      if (projected > h * 0.35) {
        haptic(6);
        const close = state.onRequestClose;
        if (close) close(velocity);
      } else {
        // Возврат на место продолжает движение пальца, а не начинается с нуля.
        state.spring.to(0, { damping: 0.82, response: 0.35, velocity });
      }
    };

    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  /* --- переключатель филиалов ---------------------------------------------
     Живой «бегунок» под активным разделом: он переезжает, а не перекрашивается.
     Так видно, что это одно и то же — просто в другом месте. */

  const segments = new WeakMap();

  function syncSegmented(box, animate) {
    const active = box.querySelector("button.is-active");
    let thumb = box.querySelector("[data-ui-thumb]");
    if (!active) {
      if (thumb) thumb.style.opacity = "0";
      return;
    }
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.setAttribute("data-ui-thumb", "");
      thumb.className = "segmented__thumb";
      box.prepend(thumb);
    }
    thumb.style.opacity = "1";
    const left = active.offsetLeft;
    thumb.style.width = `${active.offsetWidth}px`;

    const state = segments.get(box) || {};
    // Панель перерисовывает переключатель целиком, то есть бегунок каждый раз
    // новый. Пружина живёт дольше — поэтому она двигает не тот узел, что был
    // при её создании, а тот, который в странице сейчас.
    state.node = thumb;
    if (!state.spring) {
      state.spring = new Spring({
        damping: 1,
        response: 0.32,
        onUpdate: (x) => {
          if (state.node) state.node.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        },
      });
      segments.set(box, state);
    }
    if (animate && state.last !== undefined && state.last !== left) {
      // Новый узел ещё не сдвинут: ставим его туда, где бегунок был, и только
      // потом отпускаем пружину — иначе он моргнёт слева.
      state.spring.onUpdate(state.spring.value, state.spring);
      state.spring.to(left);
    } else {
      state.spring.set(left);
    }
    state.last = left;
  }

  function watchSegmented() {
    const boxes = () => document.querySelectorAll(".segmented");
    const refresh = (animate) => boxes().forEach((box) => syncSegmented(box, animate));

    const observer = new MutationObserver((records) => {
      const touched = new Set();
      records.forEach((record) => {
        // Свои же вставки бегунка игнорируем, иначе получится вечный круг.
        if (record.target && record.target.hasAttribute && record.target.hasAttribute("data-ui-thumb")) return;
        const box = record.target.closest ? record.target.closest(".segmented") : null;
        if (box) touched.add(box);
      });
      touched.forEach((box) => syncSegmented(box, true));
    });

    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    addEventListener("resize", () => refresh(false));
    refresh(false);
  }

  /* --- шапка ---------------------------------------------------------------
     Пока содержимое не подъехало под шапку, никакой линии и никакого стекла
     нет — шапка просто часть фона. Как только под неё уходит текст, появляется
     размытие и волосяная линия, а крупный заголовок ужимается. Разделитель
     возникает ровно там, где он что-то разделяет. */

  function watchScroll() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    let queued = false;

    const apply = () => {
      queued = false;
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const p = Math.max(0, Math.min(1, y / 44));
      topbar.style.setProperty("--nav-p", p.toFixed(3));
      topbar.classList.toggle("is-scrolled", y > 2);
    };

    addEventListener(
      "scroll",
      () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(apply);
      },
      { passive: true }
    );
    apply();
  }

  /* --- запуск -------------------------------------------------------------- */

  function boot() {
    document.documentElement.classList.toggle("is-touch", coarse.matches);
    // Открыта с домашнего экрана — значит, окна и отступы можно считать «своими».
    const standalone =
      matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    document.documentElement.classList.toggle("is-standalone", standalone);
    watchSegmented();
    watchScroll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.UI = {
    Spring,
    spring: (options) => new Spring(options),
    project,
    rubberband,
    haptic,
    present,
    dismiss,
    cancelDismiss,
    isPhone,
    reduceMotion,
  };
})();
