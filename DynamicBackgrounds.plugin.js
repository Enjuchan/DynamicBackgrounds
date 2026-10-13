/**
 * @name DynamicBackgrounds
 * @author Enju
 * @description Extends Discord themes with background images, slideshow, transitions and ambient effects.
 * @version 3.11.0
 * @source https://github.com/Enjuchan/DynamicBackgrounds/blob/main/DynamicBackgrounds.plugin.js
 * @updateUrl https://raw.githubusercontent.com/Enjuchan/DynamicBackgrounds/main/DynamicBackgrounds.plugin.js
 * @website https://github.com/Enjuchan/DynamicBackgrounds
 */

/* Based on BackgroundManager by Naru-kami, MIT licensed:
   https://github.com/Naru-kami/BackgroundManager-plugin

   This plugin started from that code and still contains parts of it.

   Die CSS-Klassen hiessen bis 3.7.2 BackgroundManager-*, geerbt aus jener
   Vorlage. Wer sie erneut umbenennt, muss das Theme mitziehen: Lovelace
   erkennt das laufende Plugin an .DynamicBackgrounds-bgContainer und tritt
   dann beim Hintergrund zurueck. */

const { React, Webpack, UI, Webpack: { Filters }, Patcher, DOM, ContextMenu, Data } = BdApi;

/** @type {typeof import("react")} */
const { useState, useEffect, useLayoutEffect, useRef, useCallback, useId, useMemo, createElement: jsx, Fragment } = React;

const DATA_BASE_NAME = 'DynamicBackgrounds';

/* ---- Timing des Stapel-Effekts in der Kategorie-Uebersicht ----
   Der Ablauf ist bewusst GESTAFFELT, damit es wie echtes Durchblaettern
   wirkt: erst wird die oberste Karte angehoben und nach hinten gefuehrt,
   und ERST DANN ruecken die anderen nach. Laufen beide gleichzeitig los,
   ist die zweite Karte schon oben, bevor die erste weg ist - dann sieht es
   aus, als wuerde sie einfach erscheinen. */
const STACK_TRAVEL_MS      = 800;  // Reise der obersten Karte (anheben, hinter den Stapel, einreihen, nachfedern)
const STACK_SHIFT_MS       = 480;  // wie lange die uebrigen Karten zum Nachruecken brauchen (federnde Kurve)
const STACK_SHIFT_DELAY_MS = 300;  // warten, bis die Karte angehoben UND hinter dem Stapel ist
                                   // (der z-index-Wechsel liegt bei 38% von STACK_TRAVEL_MS)

/* Sperre gegen erneutes Ausloesen: so lange, wie die laengste Bewegung dauert. */
const STACK_ANIM_MS = Math.max(STACK_TRAVEL_MS, STACK_SHIFT_MS + STACK_SHIFT_DELAY_MS);

/* Flug beim Oeffnen und Schliessen einer Kategorie: wie viele Kacheln fliegen,
   Versatz zwischen ihnen und Dauer. Die Kurve ist die federnde des Managers. */
const FLIGHT_MAX_TILES = 8;
const FLIGHT_STAGGER_MS = 38;
const FLIGHT_MS = 640;
const FLIGHT_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/* Wer Bewegung abgewaehlt hat, bekommt weder Flug noch Neigung noch Nachfedern.
   Bei jedem Aufruf gelesen, damit eine Umstellung sofort gilt. */
const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ÜBERGÄNGE - laufen einmal beim Bildwechsel, Dauer aus den Einstellungen. */
const transitionTypes = {
  fade:     'Fade',
  slide:    'Slide (horizontal)',
  slideup:  'Slide (from bottom)',
  zoom:     'Zoom in',
  zoomout:  'Zoom out',
  blur:     'Blur',
  spin:     'Spin',
  curtain:  'Curtain',
  wipe:     'Wipe',
  iris:     'Iris'
};

/* DAUEREFFEKTE - liegen permanent auf dem Bild und laufen weiter.
   Frei mit jedem Übergang kombinierbar. */
const ambientTypes = {
  none:      'None',
  kenburns:  'Ken Burns',
  drift:     'Drift',
  pulse:     'Breathe',
  grain:     'Film grain',
  scanlines: 'Scanlines',
  glitch:    'Glitch'
};

/* Alte gespeicherte Werte auf die neue Aufteilung umbiegen. */
/* Name der Auffang-Kategorie. Sie nimmt Bilder ohne eigene Zuordnung auf und
   laesst sich nicht loeschen - beim Loeschen anderer Kategorien landen deren
   Bilder hier, statt verwaist zu werden. */
const FALLBACK_CATEGORY = 'Uncategorized';

/* Bis Version 3.4.3 hiess sie 'Standard'. Der Name steht an jedem Bild in der
   Datenbank, ein blosses Umbenennen wuerde also eine zweite, leere Kategorie
   erzeugen und die vorhandenen Bilder verwaist zuruecklassen. */
const LEGACY_FALLBACK_CATEGORY = 'Standard';


/* Reihenfolge der Diashow, wenn Shuffle AUS ist.

   Kategorien alphabetisch, innerhalb einer Kategorie nach id - das ist die
   Reihenfolge, in der die Bilder auch im Raster stehen. Derselbe Vergleich wie
   bei allCategories im Manager, damit Anzeige und Ablauf uebereinstimmen.

   Warum eine gemeinsame Funktion: Es gibt ZWEI Wege, die das Bild
   weiterschalten - den Takt der Diashow in slideShowManager.tick() und den
   Knopf "Next background" ueber onNextShuffle(). Beide hatten ihre eigene
   Auswahl, und eine Korrektur an nur einem Weg blieb ohne sichtbare Wirkung. */

/* Naechste freie id fuer ein neues Bild.

   Bewusst die HOECHSTE vorhandene id plus eins, nicht die ANZAHL plus eins.
   Vorher stand an beiden Hinzufuege-Stellen `id: liste.length + 1`. Solange nur
   hinzugefuegt wird, geht das gut - nach dem Loeschen eines Bildes nicht mehr:
   Die Anzahl sinkt, die naechste vergebene id existiert bereits, und weil id
   der keyPath der IndexedDB ist, ueberschreibt der put den vorhandenen
   Datensatz. Ein Bild verschwindet dann still, ohne Fehlermeldung.

   Bei 34 Bildern mit den ids 1..34 und einer Loeschung vergibt length + 1 die
   34 erneut - und damit genau das Bild, das noch da ist. */
function naechsteId(liste) {
  let hoechste = 0;
  for (const e of liste || []) {
    const n = Number(e?.id);
    if (Number.isFinite(n) && n > hoechste) hoechste = n;
  }
  return hoechste + 1;
}

function vergleicheNachKategorie(a, b) {
  const ka = a.category || FALLBACK_CATEGORY;
  const kb = b.category || FALLBACK_CATEGORY;
  const k = ka.localeCompare(kb, undefined, { sensitivity: 'base' });
  return k !== 0 ? k : (a.id ?? 0) - (b.id ?? 0);
}

const legacyTransitionMap = {
  /* rotateY auf einer vollflaechigen Ebene laeuft in Electron unrund - der
     Browser muss dafuer jedes Bild neu rastern. Ersatzlos gestrichen,
     gespeicherte Werte landen auf "Drehen". */
  flip:     { type: 'spin' },
  svgwipe:  { type: 'wipe' },
  cube:     { type: 'spin' },
  focus:    { type: 'blur' },
  pixelate: { type: 'zoom' },
  particle: { type: 'fade' },
  kenburns: { type: 'fade', ambient: 'kenburns' },
  parallax: { type: 'fade', ambient: 'drift' },
  glitch:   { type: 'fade', ambient: 'glitch' },
  film:     { type: 'fade', ambient: 'grain' }
};

function migrateTransition(transition) {
  const t = { ...(transition || {}) };
  if (!t.ambient) t.ambient = 'none';
  const mapped = legacyTransitionMap[t.type];
  if (mapped) {
    t.type = mapped.type;
    if (mapped.ambient && t.ambient === 'none') t.ambient = mapped.ambient;
  }
  if (typeof t.ambientSpeed !== 'number' || !isFinite(t.ambientSpeed)) t.ambientSpeed = 100;
  t.ambientSpeed = Math.min(600, Math.max(10, t.ambientSpeed));
  if (!transitionTypes[t.type]) t.type = 'fade';
  if (!ambientTypes[t.ambient]) t.ambient = 'none';
  return t;
}

module.exports = meta => {
  'use strict';
  const defaultSettings = {
    enableDrop: false,
    transition: { enabled: true, duration: 1000, type: 'fade', ambient: 'none', ambientSpeed: 100 },
    slideshow: { enabled: false, interval: 10000, shuffle: true, favoritesOnly: false, categoryFilter: null, categoryFilters: [] },
    // Standard AUS: das Plugin bringt seine eigene Hintergrund-Ebene mit (siehe
    // viewTransition.create). overwriteCSS ist nur ein Kompatibilitaets-Feature fuer
    // fremde Themes, die ihren Hintergrund ueber eine eigene CSS-Variable setzen.
    overwriteCSS: false,
    adjustment: {
      xPosition: 0,
      yPosition: 0,
      /* Nicht 0: Seit die Flaechen immer durchsichtig sind, liegt der Text
         direkt auf dem Bild. Ohne Abdunklung ist er auf hellen Motiven kaum zu
         lesen, und der erste Eindruck nach dem Einschalten waere "unbrauchbar".
         0.3 ist dunkel genug zum Lesen und hell genug, dass das Motiv wirkt. */
      dimming: 0.3,
      blur: 0,
      grayscale: 0,
      saturate: 100,
      contrast: 100
    },
    addContextMenu: true,
    categories: [FALLBACK_CATEGORY],
    selectedCategory: null
  }

  /** @type { {settings: typeof defaultSettings, [key: string]: unknown} } */
  const constants = {};

  // ObjectURL helpers to centralize create/revoke and avoid leaks
  function ensureObjectURL(item) {
    try {
      if (!item) return null;
      if (item.src) return item.src;
      if (item._bgObjectURL) return item._bgObjectURL;
      if (item.image) {
        const url = URL.createObjectURL(item.image);
        item._bgObjectURL = url;
        // also mirror to src for older codepaths
        item.src = url;
        return url;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function setObjectURL(target, blob) {
    try {
      if (!target) return null;
      if (target._bgObjectURL) {
        try { URL.revokeObjectURL(target._bgObjectURL); } catch (e) {}
        target._bgObjectURL = null;
      }
      if (!blob) {
        target.src = null;
        return null;
      }
      const url = URL.createObjectURL(blob);
      target._bgObjectURL = url;
      target.src = url;
      return url;
    } catch (e) { return null; }
  }

  function clearObjectURL(target) {
    try {
      if (!target) return;
      if (target._bgObjectURL) {
        try { URL.revokeObjectURL(target._bgObjectURL); } catch (e) {}
        target._bgObjectURL = null;
      }
      if (target._thumbObjectURL) {
        try { URL.revokeObjectURL(target._thumbObjectURL); } catch (e) {}
        target._thumbObjectURL = null;
      }
      if (target.src && (!target.image || target.src !== target.image)) target.src = null;
    } catch (e) { /* ignore */ }
  }

  /* Der Zwischenspeicher der Diashow ist eine Kopie der Sammlung vom letzten
     Speichern. Direkt nach dem Oeffnen des Managers stammt er noch vom
     Schliessen und hat fuer nicht gewaehlte Bilder kein src, der Manager gilt
     aber schon als offen und die Diashow erzeugt dann keine Quelle. Der Takt
     holt sie hier nach; die URL gehoert der Diashow (_slideURL) und wird beim
     naechsten Wechsel wieder freigegeben. */
  function ensureSlideSrc(item) {
    if (!item.src && item.image) {
      item._slideURL = URL.createObjectURL(item.image);
      item.src = item._slideURL;
    }
    return item.src;
  }
  function releaseSlideSrc(item) {
    if (!item._slideURL) return;
    try { URL.revokeObjectURL(item._slideURL); } catch (e) {}
    if (item.src === item._slideURL) item.src = null;
    item._slideURL = null;
  }

  /* VORSCHAUBILDER ---------------------------------------------------------

     Das Raster zeigt Bilder auf rund 240px Breite, gespeichert sind sie aber in
     voller Aufloesung. Entscheidend ist dabei nicht die Dateigroesse, sondern
     die Pixelzahl: Dekodiert kostet ein Bild Breite * Hoehe * 4 Bytes, egal wie
     gut es komprimiert ist. Gemessen an einer echten Sammlung: 2688x1536 sind
     600 KB als Datei und 15,8 MB im Speicher, Faktor 26.

     Weil die Kategorien als aufgefaecherte Stapel mit je fuenf Karten
     nebeneinander liegen, ist praktisch die ganze Sammlung gleichzeitig gemalt.
     Bei 34 Bildern waren das rund 537 MB.

     Deshalb liegt neben dem Original eine kleine Fassung unter .thumb. Das
     Original wird NICHT angetastet und weiterhin als Hintergrund benutzt - die
     Vorschau ist ausschliesslich fuer die Rasteransicht da. */
  const THUMB_WIDTH = 480;

  function ensureThumbURL(item) {
    try {
      if (!item) return null;
      if (item._thumbObjectURL) return item._thumbObjectURL;
      if (item.thumb instanceof Blob) {
        const url = URL.createObjectURL(item.thumb);
        item._thumbObjectURL = url;
        return url;
      }
    } catch (e) { /* ignore */ }
    /* Noch keine Vorschau vorhanden - bis backfillThumbs durch ist, wird das
       Original gezeigt. Lieber kurz teuer als ein leeres Raster. */
    return item?.src || ensureObjectURL(item);
  }
  /**
   * @typedef {Object} ImageItem
   * @property {Blob} image - The image blob.
   * @property {boolean} selected - The selected Image for the background.
   * @property {boolean} favorite - Whether the image is marked as favorite.
   * @property {string} category - The category/folder of the image.
   * @property {string} src - The objectURL for the image
   * @property {number} id - The ID of the image.
   * @property {width} width - The width of the image.
   * @property {height} height - The height of the image.
  */

  // Hooks
  /** @returns {[typeof defaultSettings, React.Dispatch<typeof defaultSettings>]} */
  function useSettings() {
    const [settings, setSettings] = useState(constants.settings);
    const setSyncedSettings = useCallback((newSettings) => {
      setSettings((prevSettings) => {
        const updatedSettings = newSettings instanceof Function ? newSettings(prevSettings) : newSettings;
        Data.save(meta.slug, 'settings', updatedSettings);
        constants.settings = { ...updatedSettings };
        return updatedSettings;
      });
    }, []);

    return [settings, setSyncedSettings]
  }

  /**
   * Utility function to open an IndexedDB database.
   * @param {string} storeName - The name of the object store.
   * @returns {Promise<IDBDatabase>} A promise that resolves to the database instance.
   */
  function openDB(storeName) {
    return new Promise((resolve, reject) => {
      // Erst oeffnen und pruefen; fehlt der Store, mit erhoehter Version nachlegen.
      const probe = indexedDB.open(DATA_BASE_NAME);

      probe.onupgradeneeded = event => {
        /** @type {IDBDatabase} */
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName))
          db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
      };

      probe.onsuccess = event => {
        /** @type {IDBDatabase} */
        const db = event.target.result;
        if (db.objectStoreNames.contains(storeName)) return resolve(db);

        // Store fehlt -> Version hochziehen und nachtraeglich anlegen.
        const nextVersion = db.version + 1;
        db.close();
        const upgrade = indexedDB.open(DATA_BASE_NAME, nextVersion);
        upgrade.onupgradeneeded = e => {
          const upgraded = e.target.result;
          if (!upgraded.objectStoreNames.contains(storeName))
            upgraded.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
        };
        upgrade.onsuccess = e => resolve(e.target.result);
        upgrade.onerror = e => reject(e.target.error);
        upgrade.onblocked = () => reject(new Error(
          `IndexedDB-Upgrade blockiert: eine andere Verbindung zu "${DATA_BASE_NAME}" ist noch offen.`
        ));
      };

      probe.onerror = event => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Utility function to get all items from the store.
   * @param {IDBDatabase} db - The database instance.
   * @param {string} storeName - The name of the object store.
   * @returns {Promise<ImageItem[]>} A promise that resolves to an array of items.
   */
  function getAllItems(db, storeName) {
    return new Promise((resolve, reject) => {
      const store = db.transaction([storeName], 'readonly').objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Utility function to save items to the store.
   * @param {IDBDatabase} db - The database instance.
   * @param {string} storeName - The name of the object store.
   * @param {ImageItem[]} newItems - The items to save.
   * @param {ImageItem[]} prevItems - The previous state of items.
   * @returns {Promise<void>}
   */
  function saveItems(db, storeName, newItems, prevItems) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      const newIds = new Set(newItems.map(item => item.id));
      const prevIds = new Set(prevItems.map(item => item.id));

      // Add/update items
      newItems.forEach(e => {
        if (!prevIds.has(e.id)) {
          store.add(e);
        } else {
          store.put(e);
        }
      });

      // Remove deleted items
      prevItems.forEach(item => {
        if (!newIds.has(item.id)) {
          store.delete(item.id);
        }
      });

      transaction.oncomplete = () => {
        try {
          // Keep an in-memory cache of images to avoid repeated DB reads
          constants._cachedImages = Array.isArray(newItems) ? newItems.map(e => ({ ...e })) : [];
        } catch (e) { /* ignore */ }
        resolve();
      };
      transaction.onerror = (event) => {
        reject(event.target.error);
      };
    });
  };

  /**
   * Custom hook for IndexedDB.
   * @param {string} storeName - The name of the object store.
   * @returns {[ImageItem[], React.Dispatch<React.SetStateAction<ImageItem[]>]} An array containing the items and a function to add items.
   */
  function useIDB(storeName = 'images') {
    /** @type [ImageItem[], React.Dispatch<React.SetStateAction<ImageItem[]>>] */
    const [items, setItems] = useState([]);
    // Ohne diese Meldung wuerde die leere Liste vor dem Laden als leere Sammlung erscheinen.
    const [ready, setReady] = useState(false);
    const countEffect = useRef(0);
    const accessDB = useCallback(/** @param {(storedItems: ImageItem[], database: IDBDatabase) => void} cb */ cb => {
      /** @type {IDBDatabase | undefined} db */
      let db;
      openDB(storeName).then(database => {
        db = database;
        return getAllItems(db, storeName);
      }).then(storedItems =>
        cb(storedItems, db)
      ).catch(err => {
        console.error('Error opening database: ', err);
      }).finally(() => {
        db?.close();
      });
    }, []);

    useEffect(() => {
      accessDB(storedItems => {
        setItems(storedItems.map(e => {
          if (!e.src) ensureObjectURL(e);
          return e;
        }))
        /* Fehlende Vorschauen im Hintergrund nachrechnen. Solange sie fehlen,
           zeigt das Raster die Originale, es ist also nur langsam, nie leer. */
        backfillThumbs(storedItems, () => setItems(prev => [...prev]));
        setReady(true);
      })
      return () => {
        accessDB((storedItems, db) => {
          const clearedItems = storedItems.map(e => {
            if (!e.selected) {
                clearObjectURL(e);
              e.src = null;
            }
            return e;
          });
          saveItems(db, storeName, clearedItems, storedItems);
        })
      }
    }, []);
    const itemsRef = useRef(items);
    useEffect(() => { itemsRef.current = items }, [items]);
    const saveChainRef = useRef(Promise.resolve());

    useEffect(() => {
      countEffect.current++;
      if (countEffect.current > 1) {
        // Chain onto the previous save so writes happen strictly one at a time, and always
        // persist the LATEST items (itemsRef.current) rather than the value captured when this
        // effect fired. Without this, uploading several images at once could trigger multiple
        // overlapping save cycles; a slower one finishing after a faster one would see the
        // faster one's newly-added items as "not in my newItems list" and delete them again.
        saveChainRef.current = saveChainRef.current.then(() => new Promise(resolve => {
          accessDB((storedItems, db) => {
            saveItems(db, storeName, itemsRef.current, storedItems).then(resolve).catch(err => { console.error('Error saving images: ', err); resolve(); });
          });
        }));
      }
    }, [items]);

    return [items, setItems, ready];
  };

  // Similar to useState, but also returns a ref with the current state. Useful when you need the most recent state when unmounting.
  function useStateWithRef(initial) {
    const [state, setState] = useState(initial);
    const ref = useRef(state);
    const setStateAndRef = useCallback((newState) => {
      ref.current = newState instanceof Function ? newState(ref.current) : newState;
      setState(newState);
    }, [setState]);

    return [state, setStateAndRef, ref];
  }

  // Components
  function IconComponent({ onClick, ...props }) {
    const handleKeyDown = useCallback(e => {
      props.onKeyDown?.(e);
      if (e.key === 'Enter' || e.key === ' ') onClick();
    }, [onClick, props.onKeyDown]);
    return jsx(IconButton, {
      TooltipProps: { text: 'DynamicBackgrounds', position: 'bottom', shouldShow: props.showTooltip },
      ButtonProps: {
        ...props,
        component: 'div',
        tabIndex: '0',
        onKeyDown: handleKeyDown,
        onClick: onClick,
        className: [constants.toolbarClasses?.iconWrapper, !props.showTooltip ? constants.toolbarClasses?.selected : undefined, constants.toolbarClasses?.clickable].join(' '),
      },
      SvgProps: {
        path: "M20 4v12H8V4zm0-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-8.5 9.67 1.69 2.26 2.48-3.1L19 15H9zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6z",
        className: constants.toolbarClasses?.icon,
      }
    })
  }

  function ManagerComponent({ onRequestClose }) {
    const mainComponent = useRef(null);
    useEffect(() => {
      let mouseDownOnPopout = false;

      /* Drei Stufen, absichtlich in dieser Reihenfolge:

         1. der Klassenname aus dem Webpack-Modul, wenn er auffindbar ist
         2. sonst ueber das Attribut - der Name "layerContainer" ueberlebt einen
            Hash-Wechsel, die Klasse selbst gibt es weiterhin
         3. sonst das Fenster selbst als Bezug

         Frueher stand hier ein hartes Aussteigen, wenn Schritt 1 fehlschlug.
         Genau das ist passiert: Discord entfernte "trapClicks", der Selektor
         wurde ".undefined", und mit dem Ausstieg wurden die Handler nie
         installiert. Das Fenster liess sich dann nur noch ueber sein Symbol
         schliessen, blieb ueber allem liegen und ging auch beim Oeffnen eines
         anderen Plugins nicht weg.

         Ein fehlender Klassenname darf eine Funktion verlangsamen oder
         ungenauer machen, aber nicht abschalten. Fuer das Schliessen bei Klick
         nach aussen genuegt das Fenster als Bezug voellig. */
      const layerContainer =
        reverseQuerySelector(mainComponent.current, '.' + constants.layerContainerClass?.layerContainer) ||
        reverseQuerySelector(mainComponent.current, '[class*="layerContainer"]') ||
        mainComponent.current;
      if (!layerContainer) return;

      const ctrl = new AbortController();
      constants.settings.enableDrop && layerContainer.style.setProperty('z-index', '2002');
      addEventListener('mousedown', e => {
        mouseDownOnPopout = layerContainer.contains(e.target)
      }, ctrl);
      addEventListener('mouseup', e => {
        // If a context menu was just opened by our code, suppress closing the popout briefly
        if (constants._suppressClose) { constants._suppressClose = false; return; }

        /* Liegt der Klick in einer Ebene UEBER der App, soll nichts zugehen -
           sonst wuerde sich das Fenster beim Bedienen des eigenen Kontextmenues
           selbst schliessen.

           Hier stand vorher [class*="layer"] in der Aufzaehlung, und das war zu
           grob: Discord haengt die gesamte App unter "layer__ baseLayer__".
           Damit traf closest() bei JEDEM Klick, die Bedingung war immer wahr,
           und das Fenster ging nie zu. Es liess sich nur noch ueber sein Symbol
           schliessen und blieb ueber allem liegen.

           Deshalb umgekehrt gefragt: Alles INNERHALB der Grundebene ist normaler
           App-Inhalt und schliesst. Was darueber liegt, schliesst nicht.

           Findet sich die Grundebene nicht mehr, wird bewusst auf "schliessen"
           zurueckgefallen. Dann geht das Fenster einmal zu viel zu, statt gar
           nicht mehr - das ist die harmlosere Richtung. */
        const baseLayer = document.querySelector('[class*="baseLayer"]');
        const ueberDerApp = (baseLayer ? !baseLayer.contains(e.target) : false)
          || !!e.target.closest('[role="menu"], [role="listbox"], [role="dialog"]');

        if (mouseDownOnPopout || layerContainer.contains(e.target) || e.target.closest('#' + meta.slug) || ueberDerApp) return;
        onRequestClose();
      }, ctrl);
      addEventListener('keydown', e => {
        // offene Loesch-Rueckfrage: Esc bricht nur diese ab
        e.key === 'Escape' && !document.querySelector('.DynamicBackgrounds-confirm') && layerContainer.childElementCount === 1 && (onRequestClose(), e.stopPropagation())
      }, { capture: true, signal: ctrl.signal });

      return () => {
        layerContainer.style.removeProperty('z-index');
        ctrl.abort();
      }
    }, []);
    // FocusLock deaktiviert - verursacht Probleme mit dem Settings-Menü
    // !constants.settings.enableDrop && constants.nativeUI.useFocusLock?.(mainComponent);

    return jsx('div', {
      ref: mainComponent,
      role: "dialog",
      tabIndex: "-1",
      "aria-modal": "true",
      style: { overflow: 'visible' },
      className: [constants.messagesPopoutClasses?.messagesPopoutWrap, 'DynamicBackgrounds-popoutWrap'].filter(Boolean).join(' '),
    }, jsx('div', { className: 'DynamicBackgrounds-popoutInner' }, jsx(ManagerBody)) )
  }

  const HEAD_ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    next: 'M5 4l10 8-10 8zM17 4h3v16h-3z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z'
  };

  /** Runder Knopf im Kopf. Das title-Attribut wird dort unterdrueckt, deshalb Discords Tooltip. */
  function HeadButton({ label, tooltip, icon, size = 18, className, ...rest }) {
    return jsx(constants.nativeUI.Tooltip, {
      spacing: 8,
      position: 'bottom',
      color: 'primary',
      hideOnClick: true,
      text: tooltip || label,
      children: ({ onContextMenu, ...tip }) => jsx('button', {
        ...tip,
        ...rest,
        type: 'button',
        'aria-label': label,
        className: 'DynamicBackgrounds-headBtn' + (className ? ' ' + className : ''),
        children: jsx('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true',
          children: jsx('path', { d: HEAD_ICONS[icon] }) })
      })
    });
  }

  /** Das Bild hinter dem Kopf und die kleine scharfe Karte davor. Zwei Ebenen je Bild:
      Das neue gleitet wie eine ausgeteilte Karte herein, das alte wird weggeschoben. */
  function HeadBackdrop({ url }) {
    const [st, setSt] = useState({ urls: [url || null, null], front: 0, n: 0 });
    useEffect(() => {
      if (!url || url === st.urls[st.front]) return;
      let aus = false;
      const img = new Image();
      img.src = url;
      // Erst blenden, wenn das Bild dekodiert ist, sonst blitzt die leere Ebene auf.
      (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
        if (aus) return;
        setSt(s => {
          if (s.urls[s.front] === url) return s;
          const hinten = 1 - s.front;
          const urls = s.urls.slice();
          urls[hinten] = url;
          return { urls, front: hinten, n: s.n + 1 };
        });
      });
      return () => { aus = true; };
    }, [url]);
    // "deal" und "out" gibt es erst nach dem ersten Wechsel, das erste Bild steht einfach da.
    const zustand = i => st.front === i ? ' on' + (st.n ? ' deal' : '') : (st.n ? ' out' : '');
    const ebenen = klasse => [0, 1].map(i => jsx('div', {
      key: i,
      'aria-hidden': 'true',
      className: klasse + zustand(i),
      style: st.urls[i] ? { backgroundImage: `url("${st.urls[i]}")` } : undefined
    }));
    return jsx(Fragment, null, [
      jsx(Fragment, { key: 'bg' }, ebenen('DynamicBackgrounds-headBg')),
      st.urls[st.front] ? jsx('div', { key: 'cards', className: 'DynamicBackgrounds-headCards', 'aria-hidden': 'true' }, ebenen('DynamicBackgrounds-headCard')) : null
    ]);
  }

  /* Magnetische Knoepfe: Kommt die Maus naeher als das 1,5-fache der Knopfgroesse,
     zieht sich der Knopf um wenige Pixel zu ihr hin und federt beim Verlassen
     zurueck. Bewegt wird ueber translate, damit die Skalierung bei Hover und
     Druck (transform) unberuehrt bleibt. Hoechstens eine Berechnung je Frame. */
  function useMagnet(headRef) {
    useEffect(() => {
      const head = headRef.current;
      const inner = head?.closest('.DynamicBackgrounds-popoutInner');
      if (!inner || prefersReducedMotion()) return;
      const ziele = head.querySelectorAll('.DynamicBackgrounds-headControls > .DynamicBackgrounds-headBtn, .DynamicBackgrounds-playWrap');
      let pos = null, frame = 0;
      const setzen = () => {
        frame = 0;
        for (const el of ziele) {
          let dx = 0, dy = 0;
          if (pos) {
            const r = el.getBoundingClientRect();
            // Die Mitte ohne die eigene Verschiebung, sonst schaukelt sich der Zug auf.
            const cx = r.left + r.width / 2 - (el._mx || 0), cy = r.top + r.height / 2 - (el._my || 0);
            const ax = pos.x - cx, ay = pos.y - cy;
            const d = Math.hypot(ax, ay), radius = r.width * 1.5;
            if (d < radius && d > 0) {
              const zug = Math.min(7, d * 0.22) * (1 - d / radius * 0.5);
              dx = ax / d * zug; dy = ay / d * zug;
            }
          }
          el._mx = dx; el._my = dy;
          el.style.translate = dx || dy ? `${dx.toFixed(1)}px ${dy.toFixed(1)}px` : '';
        }
      };
      const planen = () => { if (!frame) frame = requestAnimationFrame(setzen); };
      const onMove = e => { pos = { x: e.clientX, y: e.clientY }; planen(); };
      const onLeave = () => { pos = null; planen(); };
      inner.addEventListener('mousemove', onMove);
      inner.addEventListener('mouseleave', onLeave);
      return () => {
        inner.removeEventListener('mousemove', onMove);
        inner.removeEventListener('mouseleave', onLeave);
        cancelAnimationFrame(frame);
        for (const el of ziele) { el._mx = el._my = 0; el.style.translate = ''; }
      };
    }, []);
  }

  /** Farbwelle beim Bildwechsel: Ein Ring in der neuen Akzentfarbe laeuft vom Abspielknopf ueber das Fenster. */
  function ColorWave({ onDone }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
      const el = ref.current;
      const inner = el?.closest('.DynamicBackgrounds-popoutInner');
      const play = inner?.querySelector('.DynamicBackgrounds-playWrap');
      if (!inner || !play) { onDone(); return; }
      const a = inner.getBoundingClientRect(), p = play.getBoundingClientRect();
      const x = p.left + p.width / 2 - a.left, y = p.top + p.height / 2 - a.top;
      const weit = Math.max(Math.hypot(x, y), Math.hypot(a.width - x, y), Math.hypot(x, a.height - y), Math.hypot(a.width - x, a.height - y));
      el.style.setProperty('--wave-x', x + 'px');
      el.style.setProperty('--wave-y', y + 'px');
      el.style.setProperty('--wave-r', Math.round(weit * 1.2) + 'px');
      // Notfall, falls das Ende der Animation nie gemeldet wird.
      const t = setTimeout(onDone, 1600);
      return () => clearTimeout(t);
    }, []);
    return jsx('div', { ref, className: 'DynamicBackgrounds-wave', 'aria-hidden': 'true' },
      jsx('div', { className: 'DynamicBackgrounds-waveRing', onAnimationEnd: onDone }));
  }

  function formatInterval(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
  }

  /** Kopf des Managers als Buehne: laufendes Bild, Kategorie und die Bedienung der Diashow. */
  function ManagerHead({ images, settings, currentId, clock, favoritesOnly, onToggleRun, onNext, onToggleShuffle }) {
    const slideshow = settings.slideshow || {};
    const current = images.find(i => i.id === currentId) || null;
    const filters = slideshow.categoryFilters?.length ? slideshow.categoryFilters
      : (slideshow.categoryFilter ? [slideshow.categoryFilter] : []);

    const title = !images.length ? 'No images yet'
      : favoritesOnly ? 'Favorites'
      : filters.length === 1 ? filters[0]
      : filters.length > 1 ? `${filters.length} categories`
      : 'All images';

    // Dieselbe Auswahl und Reihenfolge wie im Takt der Diashow (slideShowManager.tick).
    const meta = useMemo(() => {
      if (!images.length) return '';
      let pool = images;
      if (favoritesOnly) {
        const favs = pool.filter(i => i.favorite);
        pool = favs.length ? favs : images;
      }
      if (filters.length) pool = pool.filter(i => filters.includes(i.category || FALLBACK_CATEGORY));
      const teile = [];
      const pos = pool.slice().sort(vergleicheNachKategorie).findIndex(i => i.id === currentId);
      if (pos >= 0) teile.push(`${pos + 1} of ${pool.length}`);
      else if (pool.length) teile.push(`${pool.length} in rotation`);
      if (slideshow.interval) teile.push(`every ${formatInterval(slideshow.interval)}`);
      return teile.join(' · ');
    }, [images, currentId, favoritesOnly, slideshow.categoryFilters, slideshow.categoryFilter, slideshow.interval]);

    const running = !!slideshow.enabled;
    const ringStyle = { '--ring-from': clock ? Math.min(1, clock.remaining / clock.total) : 1 };
    const ringRunning = !!(clock && clock.running);
    if (ringRunning) ringStyle['--ring-ms'] = Math.round(clock.remaining) + 'ms';

    const headRef = useRef(null);
    useMagnet(headRef);

    return jsx('div', { ref: headRef, className: 'DynamicBackgrounds-head' + (current ? ' hasCard' : '') }, [
      jsx(HeadBackdrop, { key: 'bg', url: current ? ensureThumbURL(current) : null }),
      jsx('div', { key: 'shade', className: 'DynamicBackgrounds-headShade' }),
      jsx('div', { key: 'text', className: 'DynamicBackgrounds-headText' }, [
        jsx('div', { key: 'e', className: 'DynamicBackgrounds-headEyebrow' }, running ? 'Now playing' : 'Paused'),
        jsx('div', { key: 't', className: 'DynamicBackgrounds-headTitle', title }, title),
        jsx('div', { key: 'm', className: 'DynamicBackgrounds-headMeta' }, meta)
      ]),
      jsx('div', { key: 'controls', className: 'DynamicBackgrounds-headControls' }, [
        jsx(HeadButton, {
          key: 'shuffle', icon: 'shuffle', label: 'Shuffle',
          tooltip: slideshow.shuffle ? 'Shuffle is on' : 'Shuffle is off',
          'aria-pressed': !!slideshow.shuffle, onClick: onToggleShuffle
        }),
        jsx('div', { key: 'play', className: 'DynamicBackgrounds-playWrap' }, [
          jsx('svg', { key: 'ring', className: 'DynamicBackgrounds-ring', viewBox: '0 0 72 72', 'aria-hidden': 'true' }, [
            jsx('circle', { key: 't', className: 'DynamicBackgrounds-ringTrack', cx: 36, cy: 36, r: 33 }),
            // Der key erneuert das Element bei jedem Wechsel, damit die Animation neu startet.
            jsx('circle', {
              key: 'b' + (clock ? clock.stamp : 0),
              className: 'DynamicBackgrounds-ringBar' + (ringRunning ? ' running' : ''),
              cx: 36, cy: 36, r: 33, pathLength: 1, style: ringStyle
            })
          ]),
          jsx(HeadButton, {
            icon: running ? 'pause' : 'play', size: 26, className: 'play',
            label: running ? 'Pause the slideshow' : 'Start the slideshow',
            onClick: onToggleRun
          })
        ]),
        jsx(HeadButton, { key: 'next', icon: 'next', label: 'Show the next background now', onClick: onNext })
      ])
    ]);
  }

  /* ---- Neigung der Stapel zur Maus ----
     Die Werte gehen als CSS-Variablen auf das Stapelelement (hoechstens einmal
     je Frame) und werden erst vom Faecher darunter ausgewertet. So bleibt das
     transform der einzelnen Karten unberuehrt. React kennt diese Variablen
     nicht, ein Rendern setzt sie also nicht zurueck. */
  /* Dieselbe Logik fuer Stapel und Kacheln, nur unterschiedlich stark. Mit
     der Neigung setzt sie die Lichtreflex-Position (--holo-x/--holo-y in
     Prozent der Karte), die der Holo-Glanz im CSS auswertet. Beim Stapel ist
     die vorderste Karte das Bezugsmass (190x120, 52px ueber dem Boden des
     Faechers), sonst bewegte sich der Reflex mit der Stapelflaeche statt mit
     der Karte. */
  function makeTilt(maxY, maxX, frontCard) {
    return {
      onMouseMove(e) {
        if (prefersReducedMotion()) return;
        const el = e.currentTarget;
        el._tiltPos = { x: e.clientX, y: e.clientY };
        if (el._tiltFrame) return;
        el._tiltFrame = requestAnimationFrame(() => {
          el._tiltFrame = 0;
          const p = el._tiltPos;
          if (!p) return;
          const r = el.getBoundingClientRect();
          const nx = Math.max(-1, Math.min(1, ((p.x - r.left) / r.width - 0.5) * 2));
          const ny = Math.max(-1, Math.min(1, ((p.y - r.top) / r.height - 0.5) * 2));
          el.style.setProperty('--tilt-y', (nx * maxY).toFixed(2) + 'deg');
          el.style.setProperty('--tilt-x', (-ny * maxX).toFixed(2) + 'deg');
          let hx = (p.x - r.left) / r.width, hy = (p.y - r.top) / r.height;
          if (frontCard) {
            const fan = el.querySelector('.DynamicBackgrounds-stackFan');
            const top = r.top + (fan ? fan.offsetHeight : 176) - 52 - 120;
            hx = (p.x - (r.left + r.width / 2 - 95)) / 190;
            hy = (p.y - top) / 120;
          }
          el.style.setProperty('--holo-x', (Math.max(-0.2, Math.min(1.2, hx)) * 100).toFixed(1) + '%');
          el.style.setProperty('--holo-y', (Math.max(-0.2, Math.min(1.2, hy)) * 100).toFixed(1) + '%');
        });
      },
      onMouseLeave(e) {
        const el = e.currentTarget;
        el._tiltPos = null;
        cancelAnimationFrame(el._tiltFrame);
        el._tiltFrame = 0;
        el.style.setProperty('--tilt-x', '0deg');
        el.style.setProperty('--tilt-y', '0deg');
      }
    };
  }
  const stackTilt = makeTilt(7, 6, true);
  const tileTilt = makeTilt(3.5, 3, false);

  /* ---- Herz-Konfetti ----
     Kurzlebige Elemente am body (die Kachel schneidet mit overflow ab), per
     Web Animations bewegt und danach entfernt. Der Notfall-Timer raeumt auf,
     falls onfinish nie kommt (z. B. abgebrochene Animation). */
  const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
  function heartConfetti(originEl, count) {
    const r = originEl.getBoundingClientRect();
    const cs = getComputedStyle(originEl);
    const colors = [cs.getPropertyValue('--dbm-accent').trim() || '#ff4f9a', cs.getPropertyValue('--dbm-accent-2').trim() || '#8b5cf6'];
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < count; i++) {
      const size = 12 + Math.random() * 10;
      const p = document.createElement('div');
      p.className = 'DynamicBackgrounds-confetti';
      p.style.cssText = `position:fixed;left:${cx - size / 2}px;top:${cy - size / 2}px;width:${size}px;height:${size}px;pointer-events:none;z-index:2147483000;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55));color:${colors[i % 2]};`;
      p.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="currentColor" d="${HEART_PATH}"/></svg>`;
      document.body.appendChild(p);
      const ang = (-90 + (Math.random() - 0.5) * 150) * Math.PI / 180;
      const dist = 55 + Math.random() * 70;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      const rot = (Math.random() - 0.5) * 220;
      const dur = 650 + Math.random() * 250;
      const remove = () => p.remove();
      try {
        const anim = p.animate([
          { transform: 'translate(0px, 0px) rotate(0deg) scale(0.3)', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${rot * 0.5}deg) scale(1)`, opacity: 1, offset: 0.45, easing: 'cubic-bezier(0.5, 0, 0.9, 0.6)' },
          { transform: `translate(${dx * 1.4}px, ${dy + 70 + Math.random() * 30}px) rotate(${rot}deg) scale(0.6)`, opacity: 0 }
        ], { duration: dur, easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)', fill: 'forwards' });
        anim.onfinish = remove;
      } catch (err) { remove(); }
      setTimeout(remove, dur + 400);
    }
  }

  /* ---- Flug zwischen Stapel und Kacheln (FLIP) ----
     Aufgenommen wird vor dem Umschalten, abgespielt nach dem Rendern. Die
     Animationen laufen ohne bleibenden fill-Zustand (nur 'backwards' fuer die
     Wartezeit): danach gelten wieder die normalen Styles, es gibt kein Springen
     am Ende. */
  function boxGeometry(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
    return {
      id: el.dataset.imgId,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      w: el.offsetWidth || r.width, h: el.offsetHeight || r.height,
      // Versatz der eigenen Transformation: das Layout-Zentrum liegt um (e, f) daneben
      e: m.e, f: m.f, ang: Math.atan2(m.b, m.a) * 180 / Math.PI,
      matrix: cs.transform === 'none' ? 'translate(0px, 0px) rotate(0deg) scale(1, 1)' : cs.transform,
      filter: cs.filter === 'none' ? 'brightness(1)' : cs.filter
    };
  }

  /** Sichtbare Karten eines Stapels, hinterste zuerst. */
  function stackCardsOf(grid, cat) {
    const stack = Array.from(grid.querySelectorAll('[data-cat]')).find(e => e.dataset.cat === cat);
    return stack ? Array.from(stack.querySelectorAll('img.DynamicBackgrounds-stackCard:not(.is-queued)')) : [];
  }

  function flyBetween(el, from, to, delay, fadeIn) {
    // Startform: Zielkasten dort, wo die Quelle liegt (Mittelpunkt, Groesse, Drehung)
    const dx = from.cx - (to.cx - to.e), dy = from.cy - (to.cy - to.f);
    const start = `translate(${dx}px, ${dy}px) rotate(${from.ang}deg) scale(${from.w / to.w}, ${from.h / to.h})`;
    return el.animate([
      { transform: start, opacity: fadeIn ? 0 : 1, filter: from.filter },
      { transform: to.matrix, opacity: 1, filter: to.filter }
    ], { duration: FLIGHT_MS, delay, easing: FLIGHT_EASE, fill: 'backwards' });
  }

  function revealElement(el, delay) {
    return el.animate([
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'translateY(0px)' }
    ], { duration: 340, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' });
  }

  /** Spielt den Flug nach dem Umschalten ab und gibt die Animationen zurueck. */
  function runFlight(grid, f, reduced) {
    const anims = [];
    if (reduced) {
      anims.push(grid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }));
      return anims;
    }
    const kids = Array.from(grid.children);
    const topOf = el => { let k = el; while (k && k.parentElement !== grid) k = k.parentElement; return k; };
    const flown = new Set();
    const source = f.source;
    if (f.cat) {
      // Oeffnen: die Kacheln fliegen aus dem Stapel an ihre Plaetze
      const front = source[source.length - 1];
      const tiles = Array.from(grid.querySelectorAll('.DynamicBackgrounds-imageWrapper')).slice(0, FLIGHT_MAX_TILES);
      if (front) tiles.forEach((tile, i) => {
        const from = source.find(g => g.id === tile.dataset.imgId);
        anims.push(flyBetween(tile, from || { ...front, w: front.w * 0.5, h: front.h * 0.5 }, boxGeometry(tile), i * FLIGHT_STAGGER_MS, !from));
        flown.add(topOf(tile));
      });
      const bar = grid.parentElement?.querySelector('.DynamicBackgrounds-categoryBar');
      if (bar) anims.push(revealElement(bar, 0));
    } else {
      // Schliessen: die Karten der Herkunftskategorie sammeln sich aus den Kacheln
      const first = source[0];
      const cards = stackCardsOf(grid, f.from);
      if (first && cards.length) {
        cards.forEach((card, i) => {
          const from = source.find(g => g.id === card.dataset.imgId);
          anims.push(flyBetween(card, from || { ...first, w: first.w * 0.6, h: first.h * 0.6, ang: 0 }, boxGeometry(card), i * FLIGHT_STAGGER_MS, !from));
        });
        const stack = topOf(cards[0]);
        flown.add(stack);
        stack.querySelectorAll('.DynamicBackgrounds-categoryLabel, .DynamicBackgrounds-stackBadge').forEach(el => anims.push(revealElement(el, 160)));
      }
    }
    kids.filter(k => !flown.has(k)).forEach((k, i) => anims.push(revealElement(k, 120 + Math.min(i, 12) * 32)));
    return anims;
  }

  function ManagerBody() {
    const [images, setImages, imagesReady] = useIDB();
    const [settings, setSettings] = useSettings();
    const [stackOffsets, setStackOffsets] = useState({});
    const [stackAnimating, setStackAnimating] = useState({});
    const gridRef = useRef(null);
    const flightRef = useRef(null);     // Aufnahme vor dem Umschalten, wartet auf das Rendern
    const flightAnims = useRef([]);
    const stackLock = useRef({});       // je Kategorie: laeuft eine Mischung, ist eine vorgemerkt
    const stackLen = useRef({});        // Bildanzahl je Kategorie, vom Rendern gepflegt
    const wheelAcc = useRef({ sum: 0, last: 0 });
    /* Mischt einen Stapel um einen Schritt (dir 1 vor, -1 zurueck). Waehrend
       einer laufenden Mischung wird hoechstens ein Schritt vorgemerkt. */
    const rotateStack = useCallback((cat, dir) => {
      const st = stackLock.current[cat] || (stackLock.current[cat] = { busy: false, pending: 0 });
      if (st.busy) { st.pending = dir; return; }
      const m = stackLen.current[cat] || 0;
      if (m < 1) return;
      st.busy = true;
      setStackAnimating(prev => ({ ...prev, [cat]: dir > 0 ? true : 'back' }));
      setStackOffsets(prev => ({ ...prev, [cat]: (((prev[cat] || 0) + dir) % m + m) % m }));
      // Sperre gegen erneutes Ausloesen waehrend der Bewegung
      setTimeout(() => {
        st.busy = false;
        setStackAnimating(prev => ({ ...prev, [cat]: false }));
        if (st.pending) { const d = st.pending; st.pending = 0; rotateStack(cat, d); }
      }, STACK_ANIM_MS);
    }, []);
    const cancelFlight = () => {
      flightAnims.current.forEach(a => a.cancel());
      flightAnims.current = [];
    };
    const [showCategoryInput, setShowCategoryInput] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const categoryInputRef = useRef(null);

    // State: Slideshow nur Favoriten (initial from saved settings)
    const [slideshowFavoritesOnly, setSlideshowFavoritesOnly] = useState(constants.settings?.slideshow?.favoritesOnly || false);
    // Export Overlay State
    const [showExportOverlay, setShowExportOverlay] = useState(false);
    // Anteil der gelesenen Bilder beim ZIP-Export; null, solange kein Export laeuft
    const [zipProgress, setZipProgress] = useState(null);

    /* Takt und laufendes Bild fuer den Kopf. Die Diashow waehlt Bilder, ohne den
       Zustand dieser Komponente zu kennen; sie meldet jeden Wechsel, und das
       laufende Bild wird dann aus ihrem Zwischenspeicher gelesen. */
    const [clock, setClock] = useState(() => {
      const t = slideShowManager.getTiming();
      return t && { ...t, endAt: Date.now() + t.remaining, stamp: 0 };
    });
    const [liveSelectedId, setLiveSelectedId] = useState(null);
    useEffect(() => {
      let zaehler = 0;
      const lesen = () => {
        const t = slideShowManager.getTiming();
        /* Eine Meldung mit demselben Ende ist keine neue Runde. Die Diashow
           meldet einen Wechsel zweimal (Takt und gespeichertes Bild); die
           zweite Meldung wuerde den Ring sonst mitten im Lauf neu starten. */
        setClock(prev => {
          if (!t) return null;
          const endAt = Date.now() + t.remaining;
          if (prev && prev.running === t.running && prev.total === t.total && Math.abs(prev.endAt - endAt) < 150) return prev;
          return { ...t, endAt, stamp: ++zaehler };
        });
        const sel = (constants._cachedImages || []).find(e => e.selected);
        if (sel) setLiveSelectedId(sel.id);
      };
      return slideShowManager.subscribe(lesen);
    }, []);
    // Bildübersicht bleibt immer gleich (nur Kategorie-Filter)
    const filteredImages = useMemo(() => {
      let imgs = images;
      if (settings.selectedCategory) imgs = imgs.filter(img => (img.category || FALLBACK_CATEGORY) === settings.selectedCategory);
      return imgs;
    }, [images, settings.selectedCategory]);

    // Gruppiere Bilder pro Kategorie für die Stack-Übersicht
    const groupedByCategory = useMemo(() => {
      const map = {};
      (settings.categories || []).forEach(c => map[c] = []);
      for (const img of images) {
        const c = img.category || FALLBACK_CATEGORY;
        if (!map[c]) map[c] = [];
        map[c].push(img);
      }
      return map;
    }, [images, settings.categories]);

    /* ALLE vorhandenen Kategorien: die eingetragenen PLUS die, die nur noch an
       Bildern haengen. Ohne diese Vereinigung waeren Bilder verwaister
       Kategorien in der Oberflaeche unerreichbar. */
    const allCategories = useMemo(() => {
      const seen = new Set();
      const out = [];
      for (const c of [...(settings.categories || []), ...Object.keys(groupedByCategory)]) {
        if (c && !seen.has(c)) { seen.add(c); out.push(c); }
      }
      return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }, [settings.categories, groupedByCategory]);

    /* Selbstheilung: verwaiste Kategorien zurueck in die Einstellungen, damit
       sie auch in den Auswahllisten auftauchen. */
    useEffect(() => {
      const known = new Set(settings.categories || []);
      const orphans = Object.keys(groupedByCategory)
        .filter(c => c && !known.has(c) && (groupedByCategory[c] || []).length > 0);
      if (!orphans.length) return;
      console.log('%c[DynamicBackgrounds] %cOrphaned categories restored:', "color:#DBDCA6;font-weight:bold", "", orphans);
      setSettings(prev => ({ ...prev, categories: [...(prev.categories || []), ...orphans] }));
    }, [groupedByCategory, settings.categories]);

    // Preload cache to avoid blank images when rotating stacks
    const preloadCache = useRef(new Set());

    // Warm-cache: preload all image.src URLs (objectURLs) so showing them is instant
    // Throttle preloads using small batches to avoid CPU/memory spikes
    useEffect(() => {
      let cancelled = false;
      const toPreload = images.filter(it => it && it.src && !preloadCache.current.has(it.id));
      const batchSize = 6;
      let idx = 0;
      const runBatch = () => {
        if (cancelled) return;
        const end = Math.min(idx + batchSize, toPreload.length);
        for (; idx < end; idx++) {
          const it = toPreload[idx];
          try {
            const img = new Image();
            img.src = it.src;
            if (img.decode) {
              img.decode().then(() => { if (!cancelled) preloadCache.current.add(it.id); }).catch(() => { if (!cancelled) preloadCache.current.add(it.id); });
            } else {
              img.onload = () => { if (!cancelled) preloadCache.current.add(it.id); };
            }
          } catch (e) { /* ignore */ }
        }
        if (idx < toPreload.length) {
          if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
          else setTimeout(runBatch, 50);
        }
      };
      if (toPreload.length) {
        if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
        else setTimeout(runBatch, 50);
      }
      return () => { cancelled = true; };
    }, [images]);

    // When stack offsets change, ensure the upcoming window images are preloaded (reduces flicker)
    // Throttled and batched similar to the global warm-cache
    useEffect(() => {
      let cancelled = false;
      try {
        const candidates = [];
        Object.keys(stackOffsets).forEach(cat => {
          const items = groupedByCategory[cat] || [];
          const m = items.length;
          if (!m) return;
          const offset = stackOffsets[cat] || 0;
          const toPreload = Math.min(6, m);
          for (let i = 0; i < toPreload; i++) {
            const it = items[(offset + i) % m];
            if (!it || !it.src) continue;
            if (preloadCache.current.has(it.id)) continue;
            candidates.push(it);
          }
        });
        const batchSize = 6;
        let idx = 0;
        const runBatch = () => {
          if (cancelled) return;
          const end = Math.min(idx + batchSize, candidates.length);
          for (; idx < end; idx++) {
            const it = candidates[idx];
            try {
              const img = new Image();
              img.src = it.src;
              if (img.decode) {
                img.decode().then(() => { if (!cancelled) preloadCache.current.add(it.id); }).catch(() => { if (!cancelled) preloadCache.current.add(it.id); });
              } else {
                img.onload = () => { if (!cancelled) preloadCache.current.add(it.id); };
              }
            } catch (e) { /* ignore */ }
          }
          if (idx < candidates.length) {
            if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
            else setTimeout(runBatch, 50);
          }
        };
        if (candidates.length) {
          if ('requestIdleCallback' in window) requestIdleCallback(runBatch, { timeout: 500 });
          else setTimeout(runBatch, 50);
        }
      } catch (e) { /* ignore */ }
      return () => { cancelled = true; };
    }, [stackOffsets, groupedByCategory, images]);

    /* Filter-Zustand fuer den Diashow-Manager. Bewusst auf constants und NICHT
       auf window: die BD-Richtlinien untersagen das Veraendern globaler Objekte,
       und constants verschwindet mit dem Plugin. */
    useEffect(() => {
      constants._slideshowFavoritesOnly = slideshowFavoritesOnly;
    }, [slideshowFavoritesOnly]);

    // Synchronisiere Kategorie-Filter-State für Slideshow persistent in Settings
    useEffect(() => {
      // Support both legacy single-value and new multi-value filters
      const filters = settings.slideshow?.categoryFilters?.length ? settings.slideshow.categoryFilters : (settings.slideshow?.categoryFilter ? [settings.slideshow.categoryFilter] : null);
      constants._slideshowCategoryFilters = filters;
    }, [settings.slideshow?.categoryFilters, settings.slideshow?.categoryFilter]);

    // Wenn die Einstellung extern (oder beim Laden) geändert wurde, synchronisiere den lokalen Toggle
    useEffect(() => {
      const fav = !!settings?.slideshow?.favoritesOnly;
      if (fav !== slideshowFavoritesOnly) setSlideshowFavoritesOnly(fav);
    }, [settings?.slideshow?.favoritesOnly]);

    const contextMenuObj = useMemo(() => {
      const saveAndCopy = givenItem => [givenItem.image.type !== 'image/gif' && {
        label: "Copy image",
        action: async () => {
          try {
            if (givenItem.image.type === 'image/png' || givenItem.image.type === 'image/jpeg') {
              const arrayBuffer = await givenItem.image.arrayBuffer()
              DiscordNative.clipboard.copyImage(new Uint8Array(arrayBuffer), givenItem.src)
            } else {
              const imageBitmap = await createImageBitmap(givenItem.image);
              const Canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
              const ctx = Canvas.getContext('2d');
              ctx.drawImage(imageBitmap, 0, 0);
              const pngBlob = await Canvas.convertToBlob({ type: 'image/png' });
              const arrayBuffer = await pngBlob.arrayBuffer()
              DiscordNative.clipboard.copyImage(new Uint8Array(arrayBuffer), givenItem.src)
            }
            UI.showToast("Image copied to clipboard.", { type: 'success' });
          } catch (err) {
              UI.showToast("Image could not be copied. " + err, { type: 'error' });
          }
        }
      }, {
        label: "Save image",
        action: async () => {
          try {
            const arrayBuffer = new Uint8Array(await givenItem.image.arrayBuffer());
            let url = givenItem.image.name
            if (!url) {
              url = (new URL(givenItem.src)).pathname.split('/').pop() || 'unknown';
              const FileExtension = {
                jpeg: [[0xFF, 0xD8, 0xFF, 0xEE]],
                jpg: [[0xFF, 0xD8, 0xFF, 0xDB], [0xFF, 0xD8, 0xFF, 0xE0], [0xFF, 0xD8, 0xFF, 0xE1]],
                png: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
                bmp: [[0x42, 0x4D]],
                gif: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
                heic: [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]],
                avif: [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]],
                webp: [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
                svg: [[0x3C, 0x73, 0x76, 0x67]],
                ico: [[0x00, 0x00, 0x01, 0x00]],
              }
              loop: for (const [ext, signs] of Object.entries(FileExtension)) {
                for (const sign of signs) {
                  if (sign.every((e, i) => e === null || e === arrayBuffer[i])) {
                    url += '.' + ext;
                    break loop;
                  }
                }
              }
            }
            DiscordNative.fileManager.saveWithDialog(arrayBuffer, url).then(() => {
              UI.showToast("Saved Image!", { type: 'success' });
            });
          } catch (err) {
            UI.showToast("Failed to save Image. " + err, { type: 'error' });
          }
        }
      }].filter(Boolean);
      return {
        saveAndCopy,
        lazyCarousel: constants.lazyCarousel ? (givenItem) => {
          try {
            constants.lazyCarousel({
              items: images.map(img => ({
                url: img.src, original: "",
                zoomThumbnailPlaceholder: img.src,
                contentType: img.image.type,
                srcIsAnimated: img.image.type === 'image/gif',
                type: 'IMAGE',
                width: img.width, height: img.height,
                sourceMetadata: {
                  identifier: {
                    filename: img.image.name,
                    size: img.image.size,
                    type: "attachment"
                  }
                },
              })),
              location: "Media Mosaic",
              startingIndex: givenItem.id - 1,
              onContextMenu: e => {
                const src = e.target.closest(`img`)?.src;
                if (!src) return;
                ContextMenu.open(e, ContextMenu.buildMenu(saveAndCopy(images.find(e => e.src === src))))
              },
            })
          } catch (err) { console.error(err) }
        } : null
      }
    }, [images]);
    const handleSelect = useCallback(index => {
      setLiveSelectedId(index);
      setImages(prev => {
        prev.forEach(e => {
          e.selected = e.id === index;
        });
        return [...prev];
      });
    }, [setImages]);
    const onNextShuffle = useCallback(() => {
      /* Dieselbe Reihenfolge wie im Takt der Diashow, siehe
         vergleicheNachKategorie. Ohne die Sortierung lief dieser Knopf in
         Hochladereihenfolge, waehrend der Takt bereits alphabetisch ging. */
      const reihenfolge = images.slice().sort(vergleicheNachKategorie);
      const currentIndex = reihenfolge.reduce((p, c, i) => c.selected ? i : p, null);
      let x, it = 0;
      do x = constants.settings.slideshow.shuffle || currentIndex === null ? Math.floor(Math.random() * reihenfolge.length) : (currentIndex + 1) % reihenfolge.length
      while (x === currentIndex && it++ < 25)
      const item = reihenfolge[x];
      handleSelect(item.id);
      constants.settings.slideshow.enabled ? slideShowManager.start() : slideShowManager.stop();
      viewTransition.setImage(item.src);
    }, [images, handleSelect]);

    // Kategorie-Funktionen
    const handleCategoryChange = useCallback((imageId, category) => {
      setImages(prev => prev.map(img => img.id === imageId ? { ...img, category } : img));
    }, [setImages]);

    const handleAddCategory = useCallback(() => {
      if (newCategoryName.trim() && !settings.categories.includes(newCategoryName.trim())) {
        setSettings(prev => ({ ...prev, categories: [...prev.categories, newCategoryName.trim()] }));
        setNewCategoryName('');
        setShowCategoryInput(false);
      }
    }, [newCategoryName, settings.categories, setSettings]);

    const handleDeleteCategory = useCallback((categoryToDelete) => {
      if (categoryToDelete === FALLBACK_CATEGORY) return;

      /* Rueckfrage vor dem Loeschen. Die Bilder bleiben erhalten und wandern
         nach FALLBACK_CATEGORY - das steht bewusst im Text, sonst rechnet man
         mit Datenverlust und traut sich nicht. Bei leeren Kategorien entfaellt
         die Rueckfrage, da gibt es nichts zu verlieren. */
      const affected = images.filter(img => (img.category || FALLBACK_CATEGORY) === categoryToDelete).length;
      if (affected > 0) {
        const message = affected === 1
          ? `Delete the category "${categoryToDelete}"?\n\n1 image will be moved to "${FALLBACK_CATEGORY}". No images are deleted.`
          : `Delete the category "${categoryToDelete}"?\n\n${affected} images will be moved to "${FALLBACK_CATEGORY}". No images are deleted.`;
        if (!confirm(message)) return;
      }

      // Bilder in dieser Kategorie auf die Auffang-Kategorie setzen
      setImages(prev => prev.map(img => img.category === categoryToDelete ? { ...img, category: FALLBACK_CATEGORY } : img));
      // Kategorie aus Liste entfernen
      setSettings(prev => {
        const nextFilters = (prev.slideshow?.categoryFilters || []).filter(c => c !== categoryToDelete);
        const nextSingleFilter = prev.slideshow?.categoryFilter === categoryToDelete ? null : prev.slideshow?.categoryFilter;
        return {
          ...prev,
          categories: prev.categories.filter(c => c !== categoryToDelete),
          selectedCategory: prev.selectedCategory === categoryToDelete ? null : prev.selectedCategory,
          // Otherwise a deleted category could stay stuck as the slideshow filter, silently leaving
          // the slideshow with zero matching images and no indication why.
          slideshow: { ...prev.slideshow, categoryFilters: nextFilters, categoryFilter: nextSingleFilter }
        };
      });
      // images muss in die Abhaengigkeiten: die Rueckfrage zaehlt daraus die
      // betroffenen Bilder, sonst arbeitet sie mit einem veralteten Stand.
    }, [images, setImages, setSettings]);

    // Export Handler
    const handleDownloadImage = useCallback(async (img) => {
      try {
        let blob;

        if (img.image && img.image instanceof Blob) {
          // Der Blob aus der IndexedDB direkt, ohne Umweg
          blob = img.image;
        } else if (img.src) {
          // Rueckfall: ueber die Objekt-URL nachladen
          const response = await fetch(img.src);
          blob = await response.blob();
        } else {
          console.error('No image data available for download');
          UI.showToast("Image cannot be downloaded - no data available", { type: 'error' });
          return;
        }
        
        const fileName = img.name || `background_${img.id}.jpg`;

        /* Bewusst der Browser-Weg ueber ein <a download>: Der Renderer hat
           keinen verlaesslichen Dateizugriff, und dieser Weg loest Discords
           eigenen Speichern-Dialog aus. */
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showToast(`"${fileName}" downloaded`, { type: 'success' });
      } catch (error) {
        console.error('Download failed:', error);
        UI.showToast("Download failed: " + error.message, { type: 'error' });
      }
    }, []);

    const handleDownloadAllZip = useCallback(async () => {
      try {
        const entries = [];
        const usedNames = new Set();
        setZipProgress(0);

        for (const img of filteredImages) {
          let blob;
          if (img.image) {
            blob = img.image;
          } else if (img.src) {
            const response = await fetch(img.src);
            blob = await response.blob();
          } else {
            continue;
          }

          // Bilder in Ordner nach Kategorie. Kategorien und Favoriten liegen nur
          // in der IndexedDB - ohne Ordner waere die Einteilung nach einem
          // Wiederherstellen verloren.
          const folder = String(img.category || FALLBACK_CATEGORY).replace(/[\\/:*?"<>|]/g, '_');
          let name = folder + '/' + (img.name || `background_${img.id}.jpg`);

          // Gleiche Dateinamen in derselben Kategorie durchnummerieren, sonst
          // ueberschreiben sich Eintraege beim Entpacken gegenseitig.
          if (usedNames.has(name)) {
            const dot = name.lastIndexOf('.');
            const base = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let n = 2;
            while (usedNames.has(`${base} (${n})${ext}`)) n++;
            name = `${base} (${n})${ext}`;
          }
          usedNames.add(name);

          entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
          setZipProgress(entries.length / filteredImages.length);
        }

        if (!entries.length) return UI.showToast('No images to export', { type: 'info' });

        const content = createZipBlob(entries);

        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'backgrounds.zip';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showToast("ZIP file downloaded", { type: 'success' });
      } catch (error) {
        console.error('ZIP Download failed:', error);
        UI.showToast("Could not create the ZIP file: " + error.message, { type: 'error' });
      } finally {
        // kurz stehen lassen, damit der Balken sein Ende erreicht, bevor er verschwindet
        setTimeout(() => setZipProgress(null), 400);
      }
    }, [filteredImages]);

    /* Loeschen und Umsortieren nummerieren die ids neu, und zwar an denselben
       Objekten. Gemerkt wird deshalb das Objekt zur id, nicht die id selbst:
       Dessen id stimmt nach dem Neunummerieren weiter. Bewusst nur an
       liveSelectedId gebunden, sonst wuerde nach dem Neunummerieren wieder ueber
       die alte id gesucht. Fehlt das Objekt (geloescht), gilt das selected-Flag. */
    const liveItem = useMemo(() => images.find(i => i.id === liveSelectedId) || null, [liveSelectedId]);
    const currentId = (liveItem && images.includes(liveItem) ? liveItem.id : null) ?? images.find(i => i.selected)?.id ?? null;

    /* Farbwelle: eine je Wechsel des laufenden Bildes. Das erste Bild nach dem
       Oeffnen (vorher null) loest keine aus. */
    const [waveKey, setWaveKey] = useState(0);
    const letzteId = useRef(currentId);
    useEffect(() => {
      const vorher = letzteId.current;
      letzteId.current = currentId;
      if (vorher != null && currentId != null && vorher !== currentId && !prefersReducedMotion()) setWaveKey(k => k + 1);
    }, [currentId]);

    /* Hochladen: der ganze Manager nimmt Dateien an. Die Ereignisse haengen am
       Fenster selbst und nicht an einer Flaeche, damit auch der Kopf und die
       Leiste Ziel sind. Ein Zaehler faengt die dragleave-Ereignisse ab, die beim
       Wechsel zwischen Kindelementen entstehen. */
    const upload = useUploader(setImages, settings.selectedCategory);
    const uploadRef = useRef(upload);
    uploadRef.current = upload;
    const contentRef = useRef(null);
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
      const inner = contentRef.current?.closest('.DynamicBackgrounds-popoutInner');
      if (!inner) return;
      let tiefe = 0;
      // Nur Dateien und Adressen von aussen. Das Umsortieren der Kacheln zieht
      // ebenfalls ein Bild und darf die Abdeckung nicht ausloesen.
      const relevant = e => {
        const t = e.dataTransfer?.types;
        return !!t && (t.includes('Files') || t.includes('text/uri-list')) && !inner.querySelector('.DynamicBackgrounds-imageWrapper.dragging');
      };
      const onEnter = e => { if (!relevant(e)) return; e.preventDefault(); tiefe++; setDragging(true); };
      const onOver = e => { if (!relevant(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
      const onLeave = e => { if (!relevant(e)) return; tiefe = Math.max(0, tiefe - 1); if (!tiefe) setDragging(false); };
      // Wurde das Ziehen ohne dragleave beendet (Abbruch mit Esc), kommt als Erstes eine Mausbewegung.
      const onMove = () => { if (tiefe) { tiefe = 0; setDragging(false); } };
      const onDrop = e => { if (!relevant(e)) return; e.preventDefault(); tiefe = 0; setDragging(false); uploadRef.current.handleDrop(e); };
      // Einfuegen aus der Zwischenablage; Textfelder behalten ihr eigenes Einfuegen.
      const onPaste = e => {
        if (e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
        uploadRef.current.handlePaste(e);
      };
      /* Ziehen nur mit "Enable drop area": Ohne die Einstellung liegt Discords eigene
         Ablageflaeche ueber dem Manager und nimmt die Datei fuer den Kanal an. Die
         Abdeckung wuerde dann etwas versprechen, das nicht passiert. */
      const ziehenAn = !!constants.settings.enableDrop;
      if (ziehenAn) {
        inner.addEventListener('dragenter', onEnter);
        inner.addEventListener('dragover', onOver);
        inner.addEventListener('dragleave', onLeave);
        inner.addEventListener('drop', onDrop);
      }
      inner.addEventListener('paste', onPaste);
      inner.addEventListener('mousemove', onMove);
      // Der Fokus liegt im Fenster, damit Strg+V ankommt.
      inner.closest('[role="dialog"]')?.focus({ preventScroll: true });
      return () => {
        inner.removeEventListener('dragenter', onEnter);
        inner.removeEventListener('dragover', onOver);
        inner.removeEventListener('dragleave', onLeave);
        inner.removeEventListener('drop', onDrop);
        inner.removeEventListener('paste', onPaste);
        inner.removeEventListener('mousemove', onMove);
      };
    }, []);

    /* Lichtschein unter dem Mauszeiger: Die Ebene gibt es nur, solange die Maus im
       Fenster ist. Der Schein liegt hinter dem Inhalt (z-index -1 in der eigenen
       Stapelebene des Fensters) und wird nur ueber transform verschoben. */
    useEffect(() => {
      const inner = contentRef.current?.closest('.DynamicBackgrounds-popoutInner');
      if (!inner || prefersReducedMotion()) return;
      let klammer = null, pos = null, frame = 0;
      const setzen = () => {
        frame = 0;
        if (!klammer || !pos) return;
        const r = inner.getBoundingClientRect();
        klammer.style.setProperty('--glow-x', (pos.x - r.left - 220).toFixed(0) + 'px');
        klammer.style.setProperty('--glow-y', (pos.y - r.top - 220).toFixed(0) + 'px');
      };
      const onMove = e => {
        pos = { x: e.clientX, y: e.clientY };
        if (!klammer) {
          klammer = document.createElement('div');
          klammer.className = 'DynamicBackgrounds-glowClip';
          klammer.setAttribute('aria-hidden', 'true');
          klammer.appendChild(document.createElement('div')).className = 'DynamicBackgrounds-glow';
          inner.insertBefore(klammer, inner.firstChild);
        }
        if (!frame) frame = requestAnimationFrame(setzen);
      };
      const weg = () => {
        cancelAnimationFrame(frame); frame = 0; pos = null;
        klammer?.remove(); klammer = null;
      };
      inner.addEventListener('mousemove', onMove);
      inner.addEventListener('mouseleave', weg);
      return () => {
        inner.removeEventListener('mousemove', onMove);
        inner.removeEventListener('mouseleave', weg);
        weg();
      };
    }, []);

    useEffect(() => { if (showCategoryInput) categoryInputRef.current?.focus(); }, [showCategoryInput]);

    /* Mausrad ueber einem Stapel blaettert ihn. Nativ und nicht passiv
       angemeldet, weil React Rad-Ereignisse passiv behandelt und dort kein
       preventDefault geht. Kleine Trackpad-Schritte werden aufsummiert; erst
       ab der Schwelle gibt es einen Mischschritt. */
    useEffect(() => {
      const grid = gridRef.current;
      if (!grid) return;
      const onWheel = e => {
        if (e.ctrlKey) return;
        const stack = e.target.closest?.('.DynamicBackgrounds-categoryStack');
        if (!stack || !stack.dataset.cat) return;
        e.preventDefault();
        const acc = wheelAcc.current;
        const now = performance.now();
        if (now - acc.last > 250) acc.sum = 0;
        acc.last = now;
        acc.sum += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
        if (Math.abs(acc.sum) < 60) return;
        const dir = acc.sum > 0 ? 1 : -1;
        acc.sum = 0;
        rotateStack(stack.dataset.cat, dir);
      };
      grid.addEventListener('wheel', onWheel, { passive: false });
      return () => grid.removeEventListener('wheel', onWheel);
    }, [rotateStack]);

    /* Jeder Wechsel zwischen Uebersicht und Kategorie laeuft hier durch: erst
       laufende Fluege abbrechen (damit ein Klick mitten im Flug nichts
       verdreht), dann die Ausgangslage aufnehmen, dann umschalten. */
    const switchCategory = (cat) => {
      cancelFlight();
      const grid = gridRef.current;
      const from = settings.selectedCategory;
      flightRef.current = grid ? {
        t: Date.now(), cat, from,
        source: (cat ? stackCardsOf(grid, cat) : Array.from(grid.querySelectorAll('.DynamicBackgrounds-imageWrapper')).slice(0, FLIGHT_MAX_TILES)).map(boxGeometry)
      } : null;
      setSettings(prev => ({ ...prev, selectedCategory: cat }));
    };
    useLayoutEffect(() => {
      const f = flightRef.current;
      flightRef.current = null;
      const grid = gridRef.current;
      if (!f || !grid || Date.now() - f.t > 1000) return;
      // Der Flug ist Zierde: scheitert er, muss der Wechsel trotzdem stehen.
      try { flightAnims.current = runFlight(grid, f, prefersReducedMotion()); }
      catch (err) { console.warn('DynamicBackgrounds: category flight failed', err); }
    }, [settings.selectedCategory]);
    useEffect(() => cancelFlight, []);

    /* Letzte Kachel des Rasters: in einer Kategorie ein Platz fuer neue Bilder,
       in der Uebersicht ein leerer Stapel fuer eine neue Kategorie. */
    const plusIcon = jsx('svg', { width: 36, height: 36, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', children: jsx('path', { d: BAR_ICONS.plus }) });
    const addTile = settings.selectedCategory
      ? jsx('button', {
          key: 'add-tile',
          type: 'button',
          className: 'DynamicBackgrounds-addTile',
          'aria-label': `Add images to ${settings.selectedCategory}`,
          onClick: upload.handleUpload,
          children: jsx('span', { className: 'DynamicBackgrounds-addFace' }, plusIcon)
        })
      : jsx('button', {
          key: 'add-tile',
          type: 'button',
          className: 'DynamicBackgrounds-addTile stack',
          'aria-label': 'New category',
          onMouseMove: stackTilt.onMouseMove,
          onMouseLeave: stackTilt.onMouseLeave,
          onClick: () => setShowCategoryInput(s => !s),
          children: [
            jsx('div', { key: 'fan', className: 'DynamicBackgrounds-stackFan' },
              jsx('span', { className: 'DynamicBackgrounds-addFace stack' }, plusIcon)),
            jsx('div', { key: 'label', className: 'DynamicBackgrounds-categoryLabel' },
              jsx('span', { className: 'DynamicBackgrounds-categoryName' }, 'New category'))
          ]
        });

    const emptyHint = constants.settings.enableDrop
      ? 'Drop images anywhere in this window or paste them'
      : 'Paste images or use the add button';
    const emptyView = !imagesReady ? null
      : (!settings.selectedCategory && !images.length)
        ? jsx(EmptyState, { key: 'empty', title: 'No backgrounds yet', hint: emptyHint, onAdd: upload.handleUpload })
        : (settings.selectedCategory && !filteredImages.length)
          ? jsx(EmptyState, { key: 'empty-category', title: 'This category is empty', hint: emptyHint, onAdd: upload.handleUpload })
          : null;

    return jsx(Fragment, {
      children: [
        jsx(ManagerHead, {
          key: 'head',
          images, settings, currentId, clock,
          favoritesOnly: slideshowFavoritesOnly,
          onNext: onNextShuffle,
          onToggleRun: () => {
            const next = !settings.slideshow?.enabled;
            setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: next } }));
            next ? slideShowManager.start() : slideShowManager.stop();
          },
          onToggleShuffle: () => setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, shuffle: !prev.slideshow?.shuffle } }))
        }),
        waveKey ? jsx(ColorWave, { key: 'wave' + waveKey, onDone: () => setWaveKey(k => (k === waveKey ? 0 : k)) }) : null,
        jsx('div', {
          ref: contentRef,
          className: [constants.messagesPopoutClasses?.messageGroupWrapper, constants.markupStyles?.markup, constants.messagesPopoutClasses?.messagesPopout, 'DynamicBackgrounds-content'].join(' '),
          children: [
            /* WERKZEUGLEISTE
               Eine einzige Reihe. Links die Bildauswahl der Diashow und die
               Kategorien, mit denen sie arbeitet; rechts die Knoepfe fuer die
               Sammlung. Das Ueberlaufmenue nimmt alles Seltene auf, auch die
               Speichergroesse, die frueher in einer eigenen Zeile stand. */
            jsx('div', {
              key: 'toolbar',
              className: 'DynamicBackgrounds-toolbar',
              children: [
                jsx(SegmentSwitch, {
                  key: 'seg',
                  label: 'Images used by the slideshow',
                  value: slideshowFavoritesOnly,
                  onChange: next => {
                    setSlideshowFavoritesOnly(next);
                    setSettings(s2 => ({ ...s2, slideshow: { ...s2.slideshow, favoritesOnly: next } }));
                  },
                  options: [
                    { value: false, label: 'All images', tooltip: 'Slideshow uses all images' },
                    { value: true, label: 'Favorites', icon: BAR_ICONS.star, tooltip: 'Slideshow uses favorites only' }
                  ]
                }),

                jsx(CategoryQuickButton, {
                  key: 'cats',
                  categories: allCategories,
                  value: settings.slideshow?.categoryFilters || (settings.slideshow?.categoryFilter ? [settings.slideshow.categoryFilter] : []),
                  onChange: arr => setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, categoryFilters: Array.isArray(arr) ? arr : (arr ? [arr] : []), categoryFilter: Array.isArray(arr) && arr.length === 1 ? arr[0] : (typeof arr === 'string' ? arr : null) } })),
                }),

                jsx('div', {
                  key: 'end',
                  className: 'DynamicBackgrounds-toolEnd',
                  children: [
                    jsx(BarButton, {
                      key: 'add',
                      className: 'primary',
                      label: 'Add images',
                      tooltip: settings.selectedCategory ? `Add images to ${settings.selectedCategory}` : 'Add images',
                      path: BAR_ICONS.addImage,
                      onClick: upload.handleUpload
                    }),
                    jsx(BarButton, {
                      key: 'more',
                      label: 'More actions',
                      path: 'M5 10.3a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4zm7 0a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4zm7 0a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4z',
                      onClick: e => {
                        e.preventDefault();
                        const cats = allCategories;
                        const gesamt = images.reduce((p, c) => p + (c.image?.size || 0) + (c.thumb?.size || 0), 0);
                        ContextMenu.open(e, ContextMenu.buildMenu([
                          { label: 'New category', action: () => setShowCategoryInput(s => !s) },
                          { label: 'Export ZIP', action: () => setShowExportOverlay(true) },
                          { type: 'separator' },
                          {
                            label: 'Open category',
                            type: 'submenu',
                            items: [
                              { label: 'All categories', action: () => setSettings(prev => ({ ...prev, selectedCategory: null })) },
                              { type: 'separator' },
                              ...cats.map(cat => ({
                                label: cat + (groupedByCategory[cat] && groupedByCategory[cat].length
                                  ? ' (' + groupedByCategory[cat].length + ')' : ' (empty)'),
                                action: () => setSettings(prev => ({ ...prev, selectedCategory: cat }))
                              }))
                            ]
                          },
                          { type: 'separator' },
                          {
                            label: 'Remove all favorites',
                            danger: true,
                            action: () => {
                              try {
                                if (!images || !images.some(i => i.favorite)) return UI.showToast('No favorites present.', { type: 'info' });
                                if (confirm('Remove all favorites?')) {
                                  setImages(prev => prev.map(i => ({ ...i, favorite: false })));
                                  UI.showToast('All favorites removed.', { type: 'success' });
                                }
                              } catch (err) { console.error(err); UI.showToast('Error removing favorites.', { type: 'error' }); }
                            }
                          },
                          { type: 'separator' },
                          /* Vorschauen zaehlen mit: Die Zeile soll den Platzbedarf des
                             Plugins nennen, und seit 3.8.0 liegt neben jedem Original
                             eine kleine Fassung. Ohne sie waere die Zahl zu niedrig. */
                          {
                            label: 'Total storage size: ' + formatNumber(gesamt) + (settings.selectedCategory ? ` (${filteredImages.length} of ${images.length})` : ''),
                            disabled: true
                          }
                        ]));
                      }
                    }),
                    jsx(InPopoutSettings, { key: 'settings', rerender: setImages })
                  ]
                })
              ]
            }),
            // Zeile zum Zurueckgehen und Loeschen, nur innerhalb einer Kategorie
            settings.selectedCategory ? jsx('div', {
              key: 'categoryBar',
              className: 'DynamicBackgrounds-categoryBar',
              children: [
                jsx('button', {
                  key: 'back',
                  className: 'DynamicBackgrounds-chip',
                  title: 'Back to the category overview',
                  onClick: () => switchCategory(null),
                  children: [jsx('span', { key: 'a', 'aria-hidden': true }, '←'), jsx('span', { key: 't' }, 'All categories')]
                }),
                settings.selectedCategory !== FALLBACK_CATEGORY ? jsx('button', {
                  key: 'delete',
                  className: 'DynamicBackgrounds-categoryButton delete',
                  title: 'Delete category',
                  'aria-label': 'Delete category',
                  onClick: () => handleDeleteCategory(settings.selectedCategory),
                  children: '×'
                }) : null
              ]
            }) : null,
            showCategoryInput ? jsx('div', {
              key: 'categoryInput',
              className: 'DynamicBackgrounds-categoryInputRow',
              children: [
                jsx('input', {
                  ref: categoryInputRef,
                  type: 'text',
                  className: 'DynamicBackgrounds-categoryInput',
                  placeholder: 'Category name...',
                  value: newCategoryName,
                  onChange: (e) => setNewCategoryName(e.target.value),
                  onKeyDown: (e) => e.key === 'Enter' && handleAddCategory()
                }),
                jsx('button', {
                  className: 'DynamicBackgrounds-categoryButton',
                  title: 'Create category',
                  'aria-label': 'Create category',
                  onClick: handleAddCategory,
                  children: '✓'
                })
              ]
            }) : null,
                jsx('div', {
                  ref: gridRef,
                  className: ['DynamicBackgrounds-gridWrapper', constants.scrollbar?.thin].join(' '),
                  children: [emptyView, (settings.selectedCategory ? filteredImages.map((e, i) => jsx(ImageComponent, {
                    key: e.src,
                    item: e,
                    isCurrent: e.id === currentId,
                    index: i,
                    contextMenuObj,
                    setImages,
                    onSelect: handleSelect,
                    categories: settings.categories,
                    onCategoryChange: handleCategoryChange
                  })) : allCategories.map(cat => {
                      const items = groupedByCategory[cat] || [];
                      const previews = items; // use full group; we'll only display up to 5 at a time
                      stackLen.current[cat] = items.length;
                      // Enthaelt diese Kategorie das Bild, das gerade laeuft?
                      const hasActive = items.some(i => i.selected);
                      return jsx('div', {
                      key: cat,
                      className: 'DynamicBackgrounds-categoryStack' + (hasActive ? ' has-active' : '') + (items.length ? '' : ' is-empty'),
                      'data-cat': cat,
                      onMouseMove: stackTilt.onMouseMove,
                      onMouseLeave: stackTilt.onMouseLeave,
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': `Category ${cat}`,
                      onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchCategory(cat); } },
                        onClick: () => switchCategory(cat),
                        children: [jsx('div', {
                          key: 'stack',
                          className: 'DynamicBackgrounds-stackFan',
                          // Die Choreografie ergibt sich aus den Slot-Positionen unten und
                          // laeuft als eine Transition.
                          onMouseEnter: () => rotateStack(cat, 1),
                          children: [(() => {
                            /* Drei Karten statt fuenf; die Rotation macht die Faecherung. */
                            const maxCount = 3;
                            const overlap = 26;   // vertikaler Versatz je Tiefe
                            const shiftX = 11;    // seitlicher Versatz je Tiefe
                            const tiltDeg = 2.6;  // Drehung je Tiefe
                            const m = previews.length;
                            const n = Math.min(m, maxCount);
                            const offset = stackOffsets[cat] || 0;
                            // Leere Kategorie: nur ein gestrichelter Umriss, damit sie sich oeffnen laesst
                            if (n === 0) return jsx('span', { key: 'ghost', className: 'DynamicBackgrounds-addFace stack' });

                            /* SLOT-MODELL
                               Jedes Bild bekommt einen Slot; der Slot allein bestimmt Position,
                               Tiefe und Sichtbarkeit. Eine Rotation erhoeht bei JEDEM Bild den
                               Slot um genau 1 - und weil alle Slot-Eigenschaften animierbar
                               sind, gleitet der komplette Stapel in einem Zug.

                                 Slot -1  "auf Abruf": unter dem Stapel, unsichtbar
                                 Slot 0   unterste sichtbare Karte
                                 Slot n-1 oberste sichtbare Karte
                                 Slot n   "ausscheidend": geometrisch auf Slot -1 gesetzt

                               Der Trick steckt in Slot n. Rein rechnerisch laege das Bild ueber
                               dem Stapel, wir platzieren es aber bewusst dort, wo Slot -1 liegt.
                               Dadurch faehrt die oberste Karte beim Rotieren nach UNTEN, rutscht
                               hinter die anderen und blendet aus - genau die Bewegung, die du
                               wolltest, nur eben als Teil derselben Transition statt als
                               vorgeschaltete Show-Einlage.

                               Die Extra-Slots werden nur gerendert, wenn genug Bilder vorhanden
                               sind. Sonst wuerde dasselbe Bild zweimal auftauchen und React
                               haette doppelte keys. */
                            // Die ausscheidende Karte (Slot n) hat Vorrang vor der
                            // Abruf-Karte (Slot -1): ihre Reise ist der eigentliche Effekt.
                            // Bei genau einem Bild Reserve reicht es nur fuer eine von beiden,
                            // sonst gaebe es doppelte React-keys.
                            const renderExiting = m > n;
                            const renderOnDeck  = m > n + 1;
                            const fromSlot = renderOnDeck ? -1 : 0;
                            const toSlot   = renderExiting ? n : n - 1;

                            // Startpunkt der Reise = Position des obersten Slots.
                            // Das Ziel ist immer die RUHEPOSITION der jeweiligen Karte, wird
                            // also weiter unten pro Karte berechnet.
                            const yFrom = -(maxCount - 1) * overlap;
                            const xFrom = 0;

                            /* Wer macht die Reise?
                               - Normalfall (mehr Bilder als Slots): die Karte auf Slot n, also
                                 die gerade oben hinausgeschobene. Sie endet unsichtbar.
                               - Kategorien mit hoechstens 5 Bildern: hier gibt es keinen Slot n,
                                 das Fenster IST die ganze Gruppe. Die oberste Karte wandert
                                 direkt auf den untersten Slot 0 - und uebernimmt die Reise
                                 selbst, endet aber SICHTBAR. Genau dieser Fall fehlte vorher,
                                 deshalb ist die Karte dort einfach verschwunden.
                               Nur waehrend einer laufenden Rotation, sonst wuerde die Animation
                               schon beim ersten Rendern losspielen. */
                            const rotating = stackAnimating[cat] === true && !prefersReducedMotion();
                            // Zurueckblaettern: die Karte, die nach vorn kommt, fliegt ueber die
                            // normale Transition ohne Wartezeit (kein Reise-Keyframe)
                            const reverse = stackAnimating[cat] === 'back';
                            const windowIsWholeGroup = (m === n);

                            const nodes = [];
                            for (let slot = fromSlot; slot <= toSlot; slot++) {
                              const p = previews[(((offset + n - 1 - slot) % m) + m) % m];
                              if (!p) continue;

                              const visible = slot >= 0 && slot <= n - 1;
                              // Slot n uebernimmt die Geometrie von Slot -1 (siehe oben)
                              const geomSlot = (slot === n) ? -1 : slot;
                              const isTraveling = rotating &&
                                (slot === n || (windowIsWholeGroup && slot === 0));

                              const baseBottom = (maxCount - n + geomSlot) * overlap;
                              const depth = n - 1 - geomSlot;
                              const horizontalOffset = -depth * shiftX;
                              const rotation = -depth * tiltDeg;
                              /* Abdunklung statt Schatten als Tiefenhinweis - funktioniert auf
                                 hellen wie dunklen Motiven. */
                              const dim = Math.max(0, 1 - depth * 0.22);

                              const targetOpacity = visible ? 1 : 0;
                              // Die Reise-Karte startet VORN (400). Wann sie nach hinten
                              // wechselt, steuern die Keyframes - nicht dieser Wert.
                              const z = isTraveling ? 400 : (visible ? slot + 150 : 1);

                              nodes.push(jsx('img', {
                                key: p.id,
                                src: ensureThumbURL(p),
                                alt: '',
                                'data-img-id': p.id,
                                onLoad: e => {
                                  try {
                                    // auf den Zielwert setzen, nicht pauschal auf 1 - sonst
                                    // wuerden die unsichtbaren Slots sichtbar
                                    e.currentTarget.style.opacity = String(isTraveling ? 1 : targetOpacity);
                                    preloadCache.current.add(p.id);
                                  } catch (err) {}
                                },
                                className: 'DynamicBackgrounds-stackCard' + (visible ? '' : ' is-queued'),
                                style: {
                                  // Stapelhoehe steckt im transform, nicht in bottom: nur so
                                  // laeuft die gesamte Bewegung ueber eine einzige animierbare
                                  // Eigenschaft. (bottom positiv = hoch, translateY negativ =
                                  // hoch, daher das Minus.)
                                  transform: `translate3d(calc(-50% + ${horizontalOffset}px), ${-baseBottom}px, 0) rotate(${rotation}deg)`,
                                  filter: `brightness(${dim})`,
                                  zIndex: z,
                                  opacity: isTraveling ? 1 : (preloadCache.current.has(p.id) ? targetOpacity : 0),
                                  // Keyframe-Koordinaten: Start ist der oberste Slot, Ziel ist
                                  // die Ruheposition dieser Karte.
                                  '--bm-x-from': `${xFrom}px`,
                                  '--bm-y-from': `${yFrom}px`,
                                  '--bm-x-to': `${horizontalOffset}px`,
                                  '--bm-y-to': `${-baseBottom}px`,
                                  '--bm-rot-to': `${rotation}deg`,
                                  '--bm-op-end': String(targetOpacity),
                                  // Die wandernde Karte laeuft ueber Keyframes mit
                                  // Zwischenstationen. Alle anderen interpolieren schlicht von
                                  // Slot zu Slot - aber mit Verzoegerung, damit sie erst
                                  // nachruecken, wenn die oberste Karte angehoben ist.
                                  animation: isTraveling
                                    ? `DynamicBackgrounds-cardToBack ${STACK_TRAVEL_MS}ms linear forwards`
                                    : 'none',
                                  transition: isTraveling
                                    ? 'none'
                                    : prefersReducedMotion()
                                      ? 'none'
                                      // federnde Kurve: die aufrueckenden Karten schwingen leicht nach
                                      : `transform ${STACK_SHIFT_MS}ms var(--dbm-ease-spring) ${reverse ? 0 : STACK_SHIFT_DELAY_MS}ms, opacity ${STACK_SHIFT_MS}ms ease ${reverse ? 0 : STACK_SHIFT_DELAY_MS}ms, box-shadow ${STACK_SHIFT_MS}ms ease ${reverse ? 0 : STACK_SHIFT_DELAY_MS}ms`
                                }
                              }));
                            }
                            return nodes;
                          })(), jsx('span', { key: 'badge', className: 'DynamicBackgrounds-stackBadge' }, String(items.length))]
                        }),
                        /* Unter dem Stapel statt darauf: auf beliebigen Motiven waere ein Label
                           mal lesbar, mal nicht. */
                        jsx('div', {
                          key: 'label',
                          className: 'DynamicBackgrounds-categoryLabel',
                          children: [
                            jsx('span', { key: 'n', className: 'DynamicBackgrounds-categoryName', children: cat })
                          ]
                        })]
                    })
                  })), settings.selectedCategory && !filteredImages.length ? null : addTile]
                }),
                jsx(DropOverlay, { key: 'drop', active: dragging, category: settings.selectedCategory || FALLBACK_CATEGORY })
          ]
        }),
        showExportOverlay ?
        // Export Gallery View
        jsx('div', {
          className: 'DynamicBackgrounds-exportOverlay',
          children: [
            // Header
            jsx('div', {
              className: 'DynamicBackgrounds-exportHead',
              children: [
                jsx('h2', { className: 'DynamicBackgrounds-exportTitle', children: 'Download images' }),
                jsx('div', {
                  className: 'DynamicBackgrounds-exportActions',
                  children: [
                    jsx('button', {
                      className: 'DynamicBackgrounds-exportButton primary',
                      onClick: handleDownloadAllZip,
                      disabled: zipProgress !== null,
                      children: zipProgress !== null ? 'Creating ZIP...' : 'All as ZIP'
                    }),
                    jsx('button', {
                      className: 'DynamicBackgrounds-exportButton secondary',
                      onClick: () => setShowExportOverlay(false),
                      children: 'Back'
                    })
                  ]
                }),
                zipProgress !== null ? jsx('div', {
                  key: 'progress',
                  className: 'DynamicBackgrounds-exportProgress',
                  role: 'progressbar',
                  'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(zipProgress * 100),
                  children: jsx('div', { className: 'DynamicBackgrounds-exportProgressFill', style: { transform: 'scaleX(' + zipProgress + ')' } })
                }) : null
              ]
            }),
            // Image grid
            jsx('div', {
              className: 'DynamicBackgrounds-exportGrid',
              children: filteredImages.map(img => jsx('div', {
                key: img.id,
                className: 'DynamicBackgrounds-exportCard',
                children: [
                  jsx('img', {
                    src: ensureThumbURL(img),
                    alt: img.name,
                    className: 'DynamicBackgrounds-exportThumb'
                  }),
                  jsx('span', {
                    className: 'DynamicBackgrounds-exportName',
                    children: img.name || `Image ${img.id}`
                  }),
                  jsx('button', {
                    className: 'DynamicBackgrounds-exportButton',
                    onClick: () => handleDownloadImage(img),
                    children: 'Download'
                  })
                ]
              }))
            })
          ]
        }) : null
      ]
    })
  }

  /* FLIP fuer das Nachruecken nach dem Loeschen: merkt die Positionen der
     Geschwister und spielt die Verschiebung ab, sobald React das Element
     entfernt hat. Der Beobachter laeuft vor dem naechsten Zeichnen. */
  function watchReflow(grid, gone) {
    if (!grid) return;
    const before = Array.from(grid.children).filter(k => k !== gone).map(k => [k, k.getBoundingClientRect()]);
    const obs = new MutationObserver(() => {
      obs.disconnect();
      try {
        before.forEach(([k, r0]) => {
          if (!k.isConnected) return;
          const r1 = k.getBoundingClientRect();
          const dx = r0.left - r1.left, dy = r0.top - r1.top;
          if (!dx && !dy) return;
          k.animate([{ translate: dx + 'px ' + dy + 'px' }, { translate: '0px 0px' }],
            { duration: 560, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
        });
      } catch (err) { /* nur Zierde */ }
    });
    obs.observe(grid, { childList: true });
    setTimeout(() => obs.disconnect(), 1500);
  }

  const FORMAT_NAMES = { webp: 'WebP', jpeg: 'JPEG', jpg: 'JPEG', png: 'PNG', gif: 'GIF', avif: 'AVIF', bmp: 'BMP' };
  /** Aufloesung, Dateigroesse und Format einer Kachel als Texte fuer die Pillen. */
  function imagePills(item) {
    const type = item.image?.type?.split('/').pop();
    return [
      item.width && item.height ? item.width + ' x ' + item.height : null,
      item.image?.size != null ? formatNumber(item.image.size) : null,
      type ? (FORMAT_NAMES[type] || type) : null
    ].filter(Boolean);
  }

  /** Ansicht fuer eine leere Sammlung oder Kategorie, mitten im Raster. */
  function EmptyState({ title, hint, onAdd }) {
    return jsx('div', {
      className: 'DynamicBackgrounds-empty',
      children: [
        jsx('div', { key: 'cards', className: 'DynamicBackgrounds-emptyCards', 'aria-hidden': 'true' },
          jsx('span', { key: 'a' }), jsx('span', { key: 'b' }), jsx('span', { key: 'c' })),
        jsx('div', { key: 'title', className: 'DynamicBackgrounds-emptyTitle' }, title),
        jsx('div', { key: 'hint', className: 'DynamicBackgrounds-emptyHint' }, hint),
        jsx('button', {
          key: 'add', type: 'button', className: 'DynamicBackgrounds-emptyButton', onClick: onAdd,
          children: [
            jsx('svg', { key: 'i', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' }, jsx('path', { d: BAR_ICONS.plus })),
            jsx('span', { key: 't' }, 'Add images')
          ]
        })
      ]
    });
  }

  function ImageComponent({ item, isCurrent, onSelect, contextMenuObj, setImages, index, categories, onCategoryChange }) {
    // Mit Vorschau gibt es sofort etwas zu zeigen; so fliegt beim Oeffnen einer
    // Kategorie kein Platzhalter. Das Einblenden bleibt den spaet geladenen.
    const hasThumb = !!(item._thumbObjectURL || item.thumb instanceof Blob);
    const [loaded, setLoaded] = useState(hasThumb);
    const [error, setError] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const wrapperRef = useRef(null);
    
    const handleImageClick = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = null;
      onSelect(item.id);
      viewTransition.setImage(item.src);
      viewTransition.commitPreview?.();
    }, [onSelect, item.id, item.src]);

    /* Live-Vorschau mit Absichts-Verzoegerung: erst nach 450ms Verweilen wird
       das Bild gezeigt. Ohne die Verzoegerung wuerde jedes Ueberstreichen des
       Rasters eine Kaskade von Bildwechseln ausloesen. */
    const previewTimer = useRef(null);
    const handlePreviewEnter = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => viewTransition.previewImage?.(item.src), 450);
    }, [item.src]);
    const handlePreviewLeave = useCallback(() => {
      previewTimer.current && clearTimeout(previewTimer.current);
      previewTimer.current = null;
      viewTransition.endPreview?.();
    }, []);
    // Beim Ausbauen aufraeumen, sonst bliebe die Vorschau haengen, wenn das
    // Fenster waehrend eines Hovers geschlossen wird.
    useEffect(() => () => {
      previewTimer.current && clearTimeout(previewTimer.current);
      viewTransition.endPreview?.();
    }, []);
    const [confirming, setConfirming] = useState(false);
    // Die eigentliche Loeschlogik, unveraendert; die Animation drumherum ist Zierde.
    const performDelete = useCallback(() => {
      clearObjectURL(item);
      setImages(prev => prev.filter(e => e.id !== item.id).map((e, i) => { e.id = i + 1; return e; }));
      item.selected && viewTransition.removeImage();
    }, [setImages, item.id, item.selected, item.src]);
    // Der Knopf oeffnet nur die Rueckfrage an der Kachel.
    const handleDelete = useCallback(e => {
      e.stopPropagation();
      setConfirming(true);
    }, []);
    /* Bestaetigt: Kachel kippt weg und faellt, dann loeschen; die uebrigen
       Kacheln rutschen per FLIP federnd nach. Die Positionen werden vor dem
       Loeschen gemerkt und im Moment des DOM-Umbaus (MutationObserver, noch
       vor dem Zeichnen) abgespielt. Scheitert die Animation, wird trotzdem
       geloescht; ein Notfall-Timer deckt den Fall ab, dass onfinish ausbleibt. */
    const handleConfirmDelete = useCallback(e => {
      e.stopPropagation();
      setConfirming(false);
      const el = wrapperRef.current;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { watchReflow(el.parentElement, el); } catch (err) { /* nur Zierde */ }
        performDelete();
      };
      if (!el || prefersReducedMotion()) return finish();
      try {
        el.style.pointerEvents = 'none';
        const anim = el.animate([
          { transform: 'rotate(0deg) translateY(0px)', opacity: 1, offset: 0 },
          { transform: 'rotate(-9deg) translateY(-8px)', opacity: 1, offset: 0.22, easing: 'cubic-bezier(0.55, 0, 0.9, 0.5)' },
          { transform: 'rotate(26deg) translateY(280px) scale(0.85)', opacity: 0, offset: 1 }
        ], { duration: 620, easing: 'ease-out', fill: 'forwards' });
        anim.onfinish = finish;
        setTimeout(finish, 900);
      } catch (err) { finish(); }
    }, [performDelete]);
    const handleToggleFavorite = useCallback(e => {
      e.stopPropagation();
      const willBe = !item.favorite;
      setImages(prev => prev.map(img => img.id === item.id ? { ...img, favorite: !img.favorite } : img));
      // Nach dem Rendern: das Herz ploppt auf (Setzen) oder zieht sich zusammen (Entfernen)
      if (prefersReducedMotion()) return;
      setTimeout(() => {
        try {
          const btn = wrapperRef.current?.querySelector('.DynamicBackgrounds-favoriteButton');
          const svg = btn?.querySelector('svg');
          if (!svg) return;
          svg.animate(willBe
            ? [{ transform: 'scale(0.4)' }, { transform: 'scale(1.55)', offset: 0.45 }, { transform: 'scale(0.92)', offset: 0.75 }, { transform: 'scale(1)' }]
            : [{ transform: 'scale(1)' }, { transform: 'scale(0.7)', offset: 0.5 }, { transform: 'scale(1)' }],
            { duration: willBe ? 480 : 220, easing: 'ease-out' });
          if (willBe) heartConfetti(btn, 8 + Math.floor(Math.random() * 5));
        } catch (err) { /* nur Zierde */ }
      }, 0);
    }, [setImages, item.id, item.favorite]);

    // Rueckfrage: Esc und Klick daneben brechen ab (Esc wird abgefangen, damit der Manager offen bleibt)
    useEffect(() => {
      if (!confirming) return;
      const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); setConfirming(false); wrapperRef.current?.focus(); } };
      const onDown = ev => { if (!wrapperRef.current?.contains(ev.target)) setConfirming(false); };
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onDown, true);
      return () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDown, true);
      };
    }, [confirming]);
    useEffect(() => {
      if (confirming) wrapperRef.current?.querySelector('.DynamicBackgrounds-confirmCancel')?.focus();
    }, [confirming]);
    const handleKeyDown = useCallback(e => {
      if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); handleImageClick(); }
    }, [handleImageClick]);
    const handleContextMenu = useCallback(e => {
      const ImageContextMenu = ContextMenu.buildMenu([
        contextMenuObj.lazyCarousel ? {
          label: "View image",
          action: () => contextMenuObj.lazyCarousel(item)
        } : undefined,
        ...contextMenuObj.saveAndCopy(item),
        { type: 'separator' },
        {
          label: "Category",
          type: 'submenu',
          items: categories.map(cat => ({
            label: cat,
            type: 'radio',
            checked: (item.category || FALLBACK_CATEGORY) === cat,
            action: () => {
              onCategoryChange(item.id, cat);
              // Menü sofort schließen und neu öffnen, damit checked-State direkt sichtbar ist
              setTimeout(() => {
                ContextMenu.close();
                ContextMenu.open(e, ContextMenu.buildMenu([
                  contextMenuObj.lazyCarousel ? {
                    label: "View image",
                    action: () => contextMenuObj.lazyCarousel(item)
                  } : undefined,
                  ...contextMenuObj.saveAndCopy(item),
                  { type: 'separator' },
                  {
                    label: "Category",
                    type: 'submenu',
                    items: categories.map(cat2 => ({
                      label: cat2,
                      type: 'radio',
                      checked: (cat === cat2),
                      action: () => {}
                    }))
                  }
                ].filter(Boolean)));
              }, 50);
            }
          }))
        }
      ].filter(Boolean));
      ContextMenu.open(e, ImageContextMenu)
    }, [item, contextMenuObj, categories, onCategoryChange]);

    // Drag & Drop Handler für Sortierung
    const handleDragStart = useCallback(e => {
      setIsDragging(true);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }, [index]);
    const handleDragEnd = useCallback(() => {
      setIsDragging(false);
    }, []);
    const handleDragOver = useCallback(e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsDragOver(true);
    }, []);
    const handleDragLeave = useCallback(() => {
      setIsDragOver(false);
    }, []);
    const handleDrop = useCallback(e => {
      e.preventDefault();
      setIsDragOver(false);
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (fromIndex !== index && !isNaN(fromIndex)) {
        setImages(prev => {
          const newItems = [...prev];
          const [movedItem] = newItems.splice(fromIndex, 1);
          newItems.splice(index, 0, movedItem);
          return newItems.map((e, i) => { e.id = i + 1; return e; });
        });
      }
    }, [index, setImages]);

    useEffect(() => {
      let first = true;
      const img = new Image();
      img.src = item.src || '';
      img.onload = () => {
        setLoaded(true);
        if (!item.height && !item.width) {
          setImages(prev => {
            const loadedItem = prev.find(e => e.id === item.id);
            loadedItem.width = img.width;
            loadedItem.height = img.height;
            return [...prev];
          });
        }
      };
      img.onerror = () => {
        if (first) {
          clearObjectURL(item);
          setObjectURL(item, item.image);
          img.src = item.src;
          first = false;
        }
        else {
          setError(true);
          setLoaded(true);
        }
      };
    }, []);

    return jsx(constants.nativeUI.FocusRing, null,
      jsx('div', {
        ref: wrapperRef,
        className: 'DynamicBackgrounds-imageWrapper' + (isCurrent ? ' selected' : '') + (confirming ? ' confirming' : '') + (isDragging ? ' dragging' : '') + (isDragOver ? ' drag-over' : ''),
        'data-img-id': item.id,
        role: 'button',
        tabIndex: 0,
        'aria-label': 'Use image ' + item.id + (isCurrent ? ' (current background)' : ''),
        onKeyDown: handleKeyDown,
        onClick: confirming ? undefined : handleImageClick,
        onMouseEnter: handlePreviewEnter,
        onMouseLeave: e => { handlePreviewLeave(); tileTilt.onMouseLeave(e); },
        onMouseMove: tileTilt.onMouseMove,
        onContextMenu: handleContextMenu,
        draggable: confirming ? "false" : "true",
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        children: [
            !loaded ? jsx('div', { className: 'DynamicBackgrounds-imageSkeleton', 'aria-hidden': 'true' }) : error ? jsx('div', { className: 'DynamicBackgrounds-imageError' },
              jsx('svg', { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' }, jsx('path', { d: 'M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2zm-3 6.42 3 3.01V19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6.58l3 2.99 4-4 4 4 4-3.99z' })),
              jsx('span', null, 'Could not load image')) : jsx('img', {
            tabIndex: '-1',
            src: ensureThumbURL(item) || '',
            className: 'DynamicBackgrounds-image' + (hasThumb ? '' : ' late'),
          }), !error ? jsx(Fragment, {
            children: [
              jsx('div', {
                className: 'DynamicBackgrounds-imageData',
                children: imagePills(item).map(text => jsx('span', { key: text }, text))
              })
            ]
          }) : null, jsx(IconButton, {
            TooltipProps: { text: item.favorite ? 'Remove favorite' : 'Mark as favorite' },
            ButtonProps: {
              'aria-label': item.favorite ? 'Remove favorite' : 'Mark as favorite',
              onClick: handleToggleFavorite,
              className: 'DynamicBackgrounds-favoriteButton' + (item.favorite ? ' active' : ''),
            },
            SvgProps: {
              width: '16', height: '16',
              path: item.favorite
                ? "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                : "M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"
            }
          }), jsx(IconButton, {
            TooltipProps: { text: 'Delete image' },
            ButtonProps: {
              'aria-label': 'Delete image',
              onClick: handleDelete,
              className: 'DynamicBackgrounds-deleteButton',
            },
            SvgProps: {
              width: '16', height: '16',
              path: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            }
          }), isCurrent ? jsx('span', { key: 'now', className: 'DynamicBackgrounds-nowBadge' }, 'Now') : null,
          confirming ? jsx('div', {
            key: 'confirm',
            className: 'DynamicBackgrounds-confirm',
            role: 'alertdialog',
            'aria-label': 'Delete this image?',
            onClick: e => e.stopPropagation(),
            children: [
              jsx('span', { key: 't', className: 'DynamicBackgrounds-confirmText' }, 'Delete this image?'),
              jsx('div', { key: 'b', className: 'DynamicBackgrounds-confirmButtons', children: [
                jsx('button', { key: 'd', className: 'DynamicBackgrounds-confirmDelete', onClick: handleConfirmDelete }, 'Delete'),
                jsx('button', { key: 'c', className: 'DynamicBackgrounds-confirmCancel', onClick: e => { e.stopPropagation(); setConfirming(false); } }, 'Cancel')
              ] })
            ]
          }) : null
        ]
      })
    )
  }

  /** Die Upload-Wege des Managers: Dateiauswahl, Ablegen und Einfuegen. Die Ablageflaeche ist entfallen, die Logik ist dieselbe. */
  function useUploader(setImages, currentCategory) {
    const [processing, setProcessing] = useState([]);

    const handleFileTransfer = useCallback(async (blob) => {
      // Optimize newly uploaded images before creating object URL
      const filename = blob?.name;
      const optimized = await optimizeNewUpload(blob, filename);
      // Gleich mit erzeugen, sonst zeigt das Raster das neue Bild bis zum
      // naechsten Oeffnen in voller Aufloesung.
      const thumb = await makeThumb(optimized);
      const img = new Image();
      img.onload = () => setImages(prev => [...prev, { id: naechsteId(prev), image: optimized, thumb, width: img.width, height: img.height, selected: false, src: img.src, category: currentCategory || FALLBACK_CATEGORY }]);
      img.onerror = () => clearObjectURL(img);
      setObjectURL(img, optimized);
    }, [setImages, currentCategory]);
    const handleUpload = useCallback(() => {
      DiscordNative.fileManager.openFiles({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Alle Bilder', extensions: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'exif', 'bmp', 'dib', 'rle', 'gif', 'avif', 'webp', 'svg', 'ico'] },
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg', 'jpe', 'jfif', 'exif'] },
          { name: 'BMP', extensions: ['bmp', 'dib', 'rle'] },
          { name: 'GIF', extensions: ['gif'] },
          { name: 'AV1 (AVIF)', extensions: ['avif'] },
          { name: 'WebP', extensions: ['webp'] },
          { name: 'SVG', extensions: ['svg'] },
          { name: 'ICO', extensions: ['ico'] },
        ]
      }).then(files => {
        if (!files.length) return;
        files.forEach(file => {
          if (!file.data || !['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'exif', 'bmp', 'dib', 'rle', 'gif', 'avif', 'webp', 'svg', 'ico'].includes(file.filename?.split('.').pop()?.toLowerCase())) {
            console.warn('Could not upload ' + file.filename + '. Data is empty or ' + file.filename + ' is not an image.');
            return UI.showToast('Could not upload ' + file.filename + '. Data is empty or not an image format.', { type: 'error' });
          }
          handleFileTransfer(new Blob([file.data], { type: getImageType(file.data) }));
        });
      }).catch(e => { console.error(e); UI.showToast('Image could not be uploaded. ' + e, { type: 'error' }) });
    }, [setImages, handleFileTransfer]);
    const handleDrop = useCallback(e => {
      const timeStamp = Date.now();
      if (e.dataTransfer?.files?.length) {
        setProcessing(prev => [...prev, timeStamp]);
        for (const droppedFile of e.dataTransfer.files) {
          handleFileTransfer(droppedFile);
        }
        setProcessing(prev => prev.filter(t => t !== timeStamp));
      } else if (e.dataTransfer?.getData('URL')) {
        setProcessing(prev => [...prev, timeStamp]);
        fetch(e.dataTransfer.getData('URL')).then(async response => {
          return response.ok ? response : Promise.reject(response.status);
        }).then(res =>
          res.headers.get('Content-Type').startsWith('image/') ?
            res.blob() :
            Promise.reject('Dropped item is not an image.')
        ).then(handleFileTransfer).catch(err => {
          UI.showToast('Image data could not be fetched. ' + err, { type: 'error' });
          console.error('Status: ', err)
        }).finally(() => {
          setProcessing(prev => prev.filter(t => t !== timeStamp));
        });
      }
    }, [handleFileTransfer, setProcessing]);
    const handlePaste = useCallback(e => {
      e.preventDefault?.();
      const timeStamp = Date.now();
      setProcessing(prev => [...prev, timeStamp]);
      let items = e.clipboardData.items;
      for (let index in items) {
        let item = items[index];
        if (item.kind === 'file') {
          handleFileTransfer(item.getAsFile());
          break;
        }
      }
      setProcessing(prev => prev.filter(t => t !== timeStamp));
    }, [handleFileTransfer, setProcessing]);

    return { processing, handleUpload, handleDrop, handlePaste };
  }

  const BAR_ICONS = {
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
    addImage: 'M19 7v2.99s-1.99.01-2 0V7h-3s.01-1.99 0-2h3V2h2v3h3v2zm-3 4V8h-3V5H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-8zM5 19l3-4 2 3 3-4 4 5z',
    folder: 'M10 4H2v16h20V6H12l-2-2z',
    chevron: 'M7 10l5 5 5-5z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6'
  };

  /** Abdeckung beim Ziehen von Dateien. Die Rahmenanimation laeuft nur, solange sie sichtbar ist. */
  function DropOverlay({ active, category }) {
    return jsx('div', { className: 'DynamicBackgrounds-dropOverlay' + (active ? ' on' : ''), 'aria-hidden': 'true' }, [
      jsx('svg', { key: 'frame', className: 'DynamicBackgrounds-dropFrame' },
        jsx('rect', { x: 1.5, y: 1.5, rx: 22, ry: 22 })),
      jsx('div', { key: 'msg', className: 'DynamicBackgrounds-dropMsg' }, [
        jsx('svg', { key: 'plus', className: 'DynamicBackgrounds-dropPlus', width: 64, height: 64, viewBox: '0 0 24 24', fill: 'currentColor' },
          jsx('path', { d: BAR_ICONS.plus })),
        jsx('div', { key: 't', className: 'DynamicBackgrounds-dropText' }, 'Drop to add to ' + category)
      ])
    ]);
  }

  /** Runder Symbolknopf der Werkzeugleiste. Das title-Attribut wird dort unterdrueckt, deshalb Discords Tooltip. */
  function BarButton({ label, tooltip, path, className, ...rest }) {
    return jsx(constants.nativeUI.Tooltip, {
      spacing: 8,
      position: 'bottom',
      color: 'primary',
      hideOnClick: true,
      text: tooltip || label,
      children: ({ onContextMenu, ...tip }) => jsx('button', {
        ...tip,
        ...rest,
        type: 'button',
        'aria-label': label,
        className: 'DynamicBackgrounds-barBtn' + (className ? ' ' + className : ''),
        children: jsx('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true',
          children: jsx('path', { d: path }) })
      })
    });
  }

  /** Umschalter mit zwei Segmenten. Der Daumen gleitet zum gewaehlten Segment. */
  function SegmentSwitch({ label, value, onChange, options }) {
    const pos = options.findIndex(o => o.value === value);
    return jsx('div', { className: 'DynamicBackgrounds-seg', role: 'radiogroup', 'aria-label': label, 'data-pos': Math.max(0, pos) }, [
      jsx('span', { key: 'thumb', className: 'DynamicBackgrounds-segThumb', 'aria-hidden': 'true' }),
      ...options.map(o => jsx(constants.nativeUI.Tooltip, {
        key: String(o.value),
        spacing: 8, position: 'bottom', color: 'primary', hideOnClick: true,
        text: o.tooltip,
        children: ({ onContextMenu, ...tip }) => jsx('button', {
          ...tip,
          type: 'button',
          role: 'radio',
          'aria-checked': o.value === value,
          className: 'DynamicBackgrounds-segBtn' + (o.value === value ? ' on' : ''),
          onClick: () => o.value !== value && onChange(o.value),
          children: [
            o.icon ? jsx('svg', { key: 'i', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', children: jsx('path', { d: o.icon }) }) : null,
            jsx('span', { key: 't' }, o.label)
          ]
        })
      }))
    ]);
  }

  /** Auswahl der Diashow-Kategorien: Feld in der Werkzeugleiste, darunter die Liste. */
  function CategoryQuickButton({ categories, value, onChange }) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef();
    // value may be array (new) or string (legacy)
    const selected = Array.isArray(value) ? value : (value ? [value] : []);
    // Schliesse Dropdown bei Klick ausserhalb
    useEffect(() => {
      if (!open) return;
      function handle(e) {
        if (!btnRef.current?.parentElement.contains(e.target)) setOpen(false);
      }
      document.addEventListener('mousedown', handle);
      return () => document.removeEventListener('mousedown', handle);
    }, [open]);
    const labelText = selected.length === 1 ? selected[0] : (selected.length ? selected.length + ' categories' : 'All categories');
    const item = (key, text, on, onClick) => jsx('div', {
      key,
      role: 'option',
      'aria-selected': on,
      tabIndex: 0,
      className: 'DynamicBackgrounds-quickMenuItem' + (on ? ' on' : ''),
      onClick,
      onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } },
      children: [
        jsx('span', { key: 't', className: 'DynamicBackgrounds-quickMenuText' }, text),
        jsx('svg', { key: 'c', className: 'DynamicBackgrounds-quickCheck', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', children: jsx('path', { d: BAR_ICONS.check }) })
      ]
    });
    return jsx('div', { className: 'DynamicBackgrounds-quickWrap' }, [
      jsx(constants.nativeUI.Tooltip, {
        key: 'field',
        spacing: 8, position: 'bottom', color: 'primary', hideOnClick: true,
        text: selected.length ? `Slideshow categories: ${selected.join(', ')}` : 'Choose which categories the slideshow uses',
        children: ({ onContextMenu, ...tip }) => jsx('button', {
          ...tip,
          ref: btnRef,
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          className: 'DynamicBackgrounds-field' + (open ? ' open' : '') + (selected.length ? ' filtered' : ''),
          onClick: () => setOpen(o => !o),
          children: [
            jsx('svg', { key: 'i', className: 'DynamicBackgrounds-fieldIcon', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', children: jsx('path', { d: BAR_ICONS.folder }) }),
            jsx('span', { key: 't', className: 'DynamicBackgrounds-fieldText' }, labelText),
            jsx('svg', { key: 'v', className: 'DynamicBackgrounds-fieldArrow', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', children: jsx('path', { d: BAR_ICONS.chevron }) })
          ]
        })
      }),
      open && jsx('div', {
        key: 'menu',
        role: 'listbox',
        className: 'DynamicBackgrounds-quickMenu',
        children: [
          item('all', 'All categories', selected.length === 0, () => { onChange([]); setOpen(false); }),
          ...categories.map(cat => item(cat, cat, selected.includes(cat), () => {
            const next = selected.includes(cat) ? selected.filter(c => c !== cat) : [...selected, cat];
            onChange(next);
            setOpen(false);
          }))
        ]
      })
    ]);
  }

  function PopoutComponent() {
    const [open, setOpen] = useState(false);
    const targetElementRef = useRef(null);
    /* Schliessen zieht das Fenster erst zum Knopf zurueck und nimmt es danach aus
       dem DOM. Die Klasse "closing" startet die Rueckbewegung; jeder Weg zum
       Schliessen (Knopf, Esc, Klick nach aussen) laeuft hierueber, ein zweiter
       Aufruf waehrend der Bewegung wird verschluckt. */
    const closing = useRef(0);
    const requestClose = useCallback(() => {
      if (closing.current) return;
      const wrap = document.querySelector('.DynamicBackgrounds-popoutWrap');
      if (!wrap || prefersReducedMotion()) { setOpen(false); return; }
      wrap.classList.add('closing');
      closing.current = setTimeout(() => { closing.current = 0; setOpen(false); }, 200);
    }, []);
    useEffect(() => () => clearTimeout(closing.current), []);
    const handleClick = useCallback(() => {
      open ? requestClose() : setOpen(true);
    }, [open, requestClose]);

    return jsx(constants.nativeUI.Popout, {
      shouldShow: open,
      animation: '1',
      position: 'bottom',
      align: 'right',
      autoInvert: false,
      spacing: 8,
      targetElementRef,
      renderPopout: () => jsx(ManagerComponent, { onRequestClose: requestClose }),
      children: (e, t) => {
        return jsx(IconComponent, {
          ...e,
          id: meta.slug,
          onClick: handleClick,
          showTooltip: !t.isShown,
          ref: targetElementRef
        })
      }
    })
  }

  function IconButton({ TooltipProps, ButtonProps, SvgProps }) {
    const { component = 'button', ...buttonRestProps } = ButtonProps;
    const { path = '', ...svgRestProps } = SvgProps;
    return jsx(constants.nativeUI.Tooltip, {
      spacing: 8,
      position: 'top',
      color: 'primary',
      hideOnClick: true,
      ...TooltipProps,
      children: ({ onContextMenu, ...restProp }) => jsx(constants.nativeUI.FocusRing, {
        children: jsx(component, {
          ...restProp,
          ...buttonRestProps,
          children: jsx('svg', {
            x: '0', y: '0',
            focusable: 'false',
            'aria-hidden': 'true',
            role: 'img',
            xmlns: "http://www.w3.org/2000/svg",
            width: "24",
            height: "24",
            fill: "none",
            viewBox: "0 0 24 24",
            children: jsx('path', {
              fill: "currentColor",
              d: path
            }),
            ...svgRestProps,
          })
        })
      })
    })
  }

  // Setting Components
  function BuildSettings() {
    const [setting, setSetting] = useSettings();

    // Eigene Wurzel, damit die --dbm-Variablen auch ausserhalb des Managers gelten
    return jsx('div', {
      className: 'DynamicBackgrounds-settings',
      children: [
        jsx(constants.nativeUI.FormTitle, { children: 'Transitions' }),
        jsx(FormSwitch, {
          value: setting.transition.enabled,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, enabled: newVal } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (newVal ? setting.transition.duration ?? 0 : 0) + 'ms');
          },
        }, 'Enable background transitions'),
        jsx(FormNumberInput, {
          disabled: !setting.transition.enabled,
          min: 1,
          value: setting.transition.duration + '',
          defaultValue: defaultSettings.transition.duration,
          label: 'Transition duration',
          suffix: 'ms',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, duration: newVal } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (setting.transition.enabled ? newVal ?? 0 : 0) + 'ms');
          },
        }),
        jsx(FormSelect, {
          disabled: !setting.transition.enabled,
          label: 'Transition effect',
          value: setting.transition.type || 'fade',
          options: Object.entries(transitionTypes).map(([value, label]) => ({ value, label })),
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, type: newVal } }));
            viewTransition.bgContainer()?.setAttribute('data-transition', newVal);
          },
        }),
        jsx(FormSelect, {
          /* Bewusst NICHT von transition.enabled abhaengig: der Dauereffekt
             liegt permanent auf dem Bild und hat mit dem Wechsel nichts zu tun.
             Er soll auch dann laufen, wenn Uebergaenge ausgeschaltet sind. */
          label: 'Ambient effect',
          value: setting.transition.ambient || 'none',
          options: Object.entries(ambientTypes).map(([value, label]) => ({ value, label })),
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, ambient: newVal } }));
            viewTransition.bgContainer()?.setAttribute('data-ambient', newVal);
          },
        }),
        jsx(FormNumberInput, {
          disabled: (setting.transition.ambient || 'none') === 'none',
          min: 10, max: 600,
          value: setting.transition.ambientSpeed ?? 100,
          defaultValue: defaultSettings.transition.ambientSpeed,
          label: 'Ambient effect speed',
          suffix: '%',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, transition: { ...prev.transition, ambientSpeed: newVal } }));
            applyAmbientSpeed(newVal);
          },
        }),
        jsx('div', { role: 'separator', className: constants.separator?.separator }),
        jsx(constants.nativeUI.FormTitle, { children: 'Slideshow' }),
        jsx(FormSwitch, {
          value: setting.slideshow.enabled,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: newVal } }));
            newVal ? slideShowManager.start() : slideShowManager.stop();
          },
        }, 'Enable slideshow'),
        jsx(FormNumberInput, {
          disabled: !setting.slideshow.enabled,
          min: 1,
          value: setting.slideshow.interval / 1000 + '',
          defaultValue: defaultSettings.slideshow.interval / 1000,
          label: 'Change interval',
          suffix: 'sec',
          onChange: newVal => {
            setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, interval: newVal * 1000 } }));
            slideShowManager.start();
          },
        }),
        jsx(FormSwitch, {
          disabled: !setting.slideshow.enabled,
          value: setting.slideshow.shuffle,
          onChange: newVal => setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, shuffle: newVal } })),
        }, 'Shuffle order'),
        // Favoriten-Filter Quick-Button kommt in die Toolbar
        // Multi-category filter: toggle which categories the slideshow should use
        jsx('div', {
          className: 'DynamicBackgrounds-filterGroup',
          children: [
            jsx('div', { className: [constants.textStyles?.defaultColor, 'DynamicBackgrounds-filterLabel'].join(' '), children: 'Category filter' }),
            jsx('div', {
              className: 'DynamicBackgrounds-filterChips',
              children: [
                jsx('button', {
                  key: 'all-categories-filter',
                  onClick: () => {
                    setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, categoryFilters: [], categoryFilter: null } }));
                    if (setting.slideshow.enabled) slideShowManager.start();
                  },
                  className: 'DynamicBackgrounds-filterChip' + (!setting.slideshow?.categoryFilters || setting.slideshow.categoryFilters.length === 0 ? ' active' : ''),
                  children: 'All categories'
                }),
                ...setting.categories.map(cat => jsx('button', {
                  key: cat,
                  onClick: () => {
                    setSetting(prev => {
                      const prevFilters = Array.isArray(prev.slideshow?.categoryFilters) ? prev.slideshow.categoryFilters.slice() : (prev.slideshow?.categoryFilter ? [prev.slideshow.categoryFilter] : []);
                      const has = prevFilters.includes(cat);
                      const next = has ? prevFilters.filter(c => c !== cat) : [...prevFilters, cat];
                      return { ...prev, slideshow: { ...prev.slideshow, categoryFilters: next, categoryFilter: next.length === 1 ? next[0] : null } };
                    });
                    if (setting.slideshow.enabled) slideShowManager.start();
                  },
                  className: 'DynamicBackgrounds-filterChip' + (Array.isArray(setting.slideshow?.categoryFilters) && setting.slideshow.categoryFilters.includes(cat) ? ' active' : ''),
                  children: cat
                }))
              ]
            })
          ]
        }),
        jsx('div', { role: 'separator', className: [constants.separator?.separator, 'DynamicBackgrounds-settingsSeparator'].join(' ') }),
        jsx(FormSwitch, {
          value: setting.enableDrop,
          note: "When enabled, the popup is moved in front of Discord's native drop area, allowing images to be dragged and dropped.",
          onChange: newVal => setSetting(prev => ({ ...prev, enableDrop: newVal })),
        }, 'Enable drop area'),
        jsx(FormSwitch, {
          value: setting.overwriteCSS,
          note: "Detects the theme's background CSS variable and overrides it. If no variable is found, the original is kept.",
          onChange: newVal => {
            setSetting(prev => ({ ...prev, overwriteCSS: newVal }));
            newVal ? (themeObserver.start(), viewTransition.setProperty()) : themeObserver.stop();
          },
        }, "Override theme CSS variable"),
        jsx(FormSwitch, {
          value: setting.addContextMenu,
          onChange: newVal => {
            setSetting(prev => ({ ...prev, addContextMenu: newVal }));
            newVal ? contextMenuPatcher.patch() : contextMenuPatcher.unpatch();
          },
        }, 'Add context menu entry on images'),
        jsx('div', { role: 'separator', className: [constants.separator?.separator, 'DynamicBackgrounds-settingsSeparator'].join(' ') }),
        jsx('div', { className: 'DynamicBackgrounds-settingsFooter' }, jsx(constants.nativeUI.Button, {
          color: constants.nativeUI.Button?.Colors?.RED || 'red',
          onClick: () => {
            UI.showConfirmationModal(
              "Delete Database",
              "This will delete the entire indexedDB database, including every Image saved on it.\n\nAre you sure you want to delete all your saved images?",
              {
                danger: true,
                confirmText: "Yes, Delete",
                onConfirm: () => {
                  viewTransition.removeImage();
                  slideShowManager.stop();
                  setSetting(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: false } }));
                  const deleteReq = indexedDB.deleteDatabase(DATA_BASE_NAME);
                  deleteReq.onblocked = () => UI.showToast("Database could not be deleted right away (a connection is still open). Please restart Discord and try again.", { type: 'warning' });
                  deleteReq.onerror = (ev) => { console.error(ev.target?.error); UI.showToast("Failed to delete the database.", { type: 'error' }); };
                }
              }
            );
          }
        }, "Delete Database"))
      ]
    })
  }

  function FormSwitch({ value, onChange, note, disabled, children }) {
    return jsx("div", {
      className: ["DynamicBackgrounds-FormSwitch", constants.textStyles?.defaultColor].filter(Boolean).join(" "),
      children: [
        jsx("label", {
          children: [
            jsx("div", null, children),
            jsx(BdApi.Components.SwitchInput, { value, onChange, disabled }),
          ]
        }),
        note && jsx("span", {
          className: [constants.textStyles?.["text-sm/normal"], 'DynamicBackgrounds-FormNote'].join(' '),
        }, note)
      ]
    })
  }

  function FormNumberInput({ value, onChange, label, suffix, defaultValue, ...restProps }) {
    const [val, setVal] = useState(value + '');
    const lastVal = useRef(value);
    const inputRef = useRef(null);

    const handleChange = useCallback(newVal => { setVal(newVal) }, [setVal]);
    const handleBlur = useCallback(() => {
      lastVal.current = !isNaN(Number(val)) ? Math.max(Number(val), restProps.min ?? Number(val)) : lastVal.current;
      onChange(lastVal.current);
      setVal(lastVal.current + '');
    }, [val, onChange, lastVal.current, setVal]);
    const handleKeyDown = useCallback(e => {
      /* Das Kontextmenue hoert global auf Tastendruecke (Navigation, Schnellsuche).
         Ohne stopPropagation kommt keine Ziffer im Feld an. Escape bleibt
         durchlaessig, damit sich das Menue schliessen laesst. */
      if (e.key !== 'Escape') e.stopPropagation?.();

      e.key === 'Enter' && e.target?.blur?.();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault?.();
          const delta = e.key === 'ArrowUp' ? 1 : -1;
          setVal(newValue => { newValue = (Number(newValue) + delta).toFixed(Math.ceil(Math.abs(Math.log10(Math.abs(restProps.min ?? 1))))); return Math.max(Number(newValue), restProps.min ?? Number(newValue)) + '' });
        }
      }
    }, [setVal]);

    useEffect(() => {
      const ctrl = new AbortController();

      inputRef.current?.addEventListener?.('wheel', e => {
        if (e.deltaY && inputRef.current === document.activeElement) {
          e.preventDefault?.();
          setVal(oldValue => {
            oldValue = (Number(oldValue) - Math.sign(e.deltaY)).toFixed(Math.ceil(Math.abs(Math.log10(Math.abs(restProps.min ?? 1)))));
            return Math.max(Number(oldValue), restProps.min ?? Number(oldValue)) + '';
          });
        }
      }, ctrl);
      inputRef.current?.addEventListener?.("beforeinput", e => {
        if (e.data && /[^0-9e\+\-.]+/.test(e.data)) e.preventDefault?.();
      }, ctrl);

      /* Discords Kontextmenue faengt Maus- und Fokus-Ereignisse ab. React-Handler
         laufen erst in der Bubble-Phase und damit zu spaet, deshalb Capture-Phase
         direkt am Feld - sonst laesst sich nicht einmal hineinklicken. */
      const swallowForMenu = e => e.stopPropagation?.();
      ['mousedown', 'pointerdown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress']
        .forEach(type => inputRef.current?.addEventListener?.(type, swallowForMenu, { capture: true, signal: ctrl.signal }));

      inputRef.current?.addEventListener?.('pointerdown', () => {
        setTimeout(() => inputRef.current?.focus?.(), 0);
      }, ctrl);

      return () => ctrl.abort();
    }, []);

    const TextInputComponent = constants.nativeUI.TextInput || (({value, onChange, inputRef, rows, ...props}) => jsx('input', {
      ref: inputRef,
      value, onChange: e => onChange(e.target.value),
      ...props,
      className: [props.className, 'DynamicBackgrounds-fallbackInput'].join(' ')
    }));

    return jsx('label', {
      className: 'DynamicBackgrounds-FormNumberInput',
      children: [
        jsx("span", { className: constants.textStyles?.defaultColor }, label ?? ''),
        jsx(TextInputComponent, {
          ...restProps,
          inputRef,
          rows: 1,
          value: val,
          className: 'DynamicBackgrounds-NumberInput',
          onChange: handleChange,
          onBlur: handleBlur,
          onKeyDown: handleKeyDown
        }), suffix ? jsx('span', { className: constants.textStyles?.defaultColor }, suffix) : null,
        /* Zuruecksetzen-Knopf, nur sichtbar bei Abweichung vom Standard. Der Klick
           muss lokalen Textzustand UND Einstellung aktualisieren. */
        defaultValue !== undefined && Number(val) !== Number(defaultValue)
          ? jsx('button', {
              type: 'button',
              className: 'DynamicBackgrounds-ResetButton',
              title: 'Reset to default (' + defaultValue + (suffix ? ' ' + suffix : '') + ')',
              'aria-label': 'Reset to default',
              onClick: e => {
                e.preventDefault?.();
                setVal(defaultValue + '');
                onChange(defaultValue);
              },
              children: '\u21ba'
            })
          : null
      ]
    })
  }

  function FormSelect({ label, value, options, onChange, disabled }) {
    return jsx('label', {
      className: 'DynamicBackgrounds-FormSelect',
      children: [
        jsx("span", { className: constants.textStyles?.defaultColor }, label ?? ''),
        jsx('select', {
          disabled,
          value,
          className: 'DynamicBackgrounds-Select',
          onChange: e => onChange(e.target.value),
          children: options.map(opt => jsx('option', { key: opt.value, value: opt.value }, opt.label))
        })
      ]
    })
  }

  function MenuNumberInput({ value, onChange, defaultValue, ...restProps }) {
    const [textValue, setTextValue, textStateRef] = useStateWithRef(value + '');
    const [sliderValue, setSliderValue, sliderStateRef] = useStateWithRef(value);
    const oldValue = useRef(value);
    const ID = useId();
    const sliderRef = useRef(null);
    const inputRef = useRef(null);

    const handleTextChange = useCallback(newValue => { setTextValue(newValue) }, [setTextValue]);
    const handleSliderChange = useCallback(newValue => {
      newValue = Number(newValue.toFixed(restProps.decimals ?? 0));
      restProps.onSlide?.(newValue);
      setSliderValue(newValue);
    }, [setSliderValue, restProps.onSlide]);

    const onTextCommit = useCallback(() => {
      oldValue.current = !isNaN(Number(textValue)) ? Math.max(Number(textValue), restProps.minValue ?? Number(textValue)) : oldValue.current;
      setTextValue(oldValue.current + '');
      setSliderValue(oldValue.current);
      sliderRef.current?._reactInternals?.stateNode?.setState?.({ value: oldValue.current });
      onChange(oldValue.current);
    }, [onChange, setSliderValue, textValue, setTextValue]);
    const handleKeyDown = useCallback(e => {
      /* Das Kontextmenue hoert global auf Tastendruecke (Navigation, Schnellsuche).
         Ohne stopPropagation kommt keine Ziffer im Feld an. Escape bleibt
         durchlaessig, damit sich das Menue schliessen laesst. */
      if (e.key !== 'Escape') e.stopPropagation?.();

      e.key === 'Enter' && e.target?.blur?.();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault?.();
          const delta = (e.key === 'ArrowUp' ? 10 : -10) * (restProps.decimals ? Math.pow(10, -1 * restProps.decimals) : 0.1);
          setTextValue(val => {
            val = (Number(val) + delta).toFixed(restProps.decimals ?? 0);
            return Math.max(Number(val), restProps.minValue ?? Number(val)) + '';
          });
        }
      }
    }, [setTextValue]);
    const onSliderCommit = useCallback(newValue => {
      const fixedValue = Number(newValue.toFixed(restProps.decimals ?? 0));
      setTextValue(fixedValue + '');
      onChange(fixedValue)
    }, [onChange, setTextValue]);

    useEffect(() => {
      const ctrl = new AbortController();

      inputRef.current?.addEventListener?.('wheel', e => {
        if (e.deltaY) {
          const delta = -10 * Math.sign(e.deltaY) * (restProps.decimals ? Math.pow(10, -1 * restProps.decimals) : 0.1);
          setTextValue(val => {
            val = (Number(val) + delta).toFixed(restProps.decimals ?? 0);
            return Math.max(Number(val), restProps.minValue ?? Number(val)) + '';
          });
        }
      }, ctrl);
      inputRef.current?.addEventListener?.("beforeinput", e => {
        if (e.data && /[^0-9e\+\-.]+/.test(e.data)) e.preventDefault?.();
      }, ctrl);

      /* Discords Kontextmenue faengt Maus- und Fokus-Ereignisse ab. React-Handler
         laufen erst in der Bubble-Phase und damit zu spaet, deshalb Capture-Phase
         direkt am Feld - sonst laesst sich nicht einmal hineinklicken. */
      const swallowForMenu = e => e.stopPropagation?.();
      ['mousedown', 'pointerdown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress']
        .forEach(type => inputRef.current?.addEventListener?.(type, swallowForMenu, { capture: true, signal: ctrl.signal }));

      inputRef.current?.addEventListener?.('pointerdown', () => {
        setTimeout(() => inputRef.current?.focus?.(), 0);
      }, ctrl);

      return () => {
        ctrl.abort();
        Number(textStateRef.current) != sliderStateRef.current && onChange(sliderStateRef.current);
      }
    }, []);

    const TextInputComponent = constants.nativeUI.TextInput || (({value, onChange, inputRef, rows, ...props}) => jsx('input', {
      ref: inputRef,
      value, onChange: e => onChange(e.target.value),
      ...props,
      className: [props.className, 'DynamicBackgrounds-fallbackInput compact'].join(' ')
    }));
    const MenuSliderControlComponent = constants.nativeUI.MenuSliderControl || (({ initialValue, onValueChange, asValueChanges, minValue, maxValue, disabled, ...props }) => jsx('input', {
      type: 'range', min: minValue, max: maxValue, defaultValue: initialValue, disabled,
      onChange: e => { const v = Number(e.target.value); asValueChanges?.(v); onValueChange?.(v); },
      ...props,
      className: [props.className, 'DynamicBackgrounds-fallbackSlider'].join(' ')
    }));

    return jsx('div', {
      className: [constants.separator?.item, constants.separator?.labelContainer, (restProps.disabled ? constants.separator?.disabled : ''), 'DynamicBackgrounds-menuRow'].join(' '),
      children: [
        jsx('div', {
          className: [constants.textStyles?.defaultColor, 'DynamicBackgrounds-menuRowHead'].join(' '),
          // Fokus gehoert an den Klick, nicht an den Mauszeiger
          onMouseDown: e => e.stopPropagation?.(),
          onClick: e => e.stopPropagation?.(),
          children: [
            jsx('label', {
              htmlFor: ID,
              children: restProps.label,
              className: [constants.separator?.label, 'DynamicBackgrounds-menuRowLabel'].join(' '),
            }),
            /* Derselbe Knopf wie im Einstellungsfenster. Steht bewusst VOR dem
               Eingabefeld, damit er beim Ein- und Ausblenden die Zahl nicht
               seitlich verschiebt. */
            defaultValue !== undefined && Number(textValue) !== Number(defaultValue)
              ? jsx('button', {
                  type: 'button',
                  className: 'DynamicBackgrounds-ResetButton',
                  title: 'Reset to default (' + defaultValue + ')',
                  'aria-label': 'Reset to default',
                  disabled: restProps.disabled,
                  onClick: e => {
                    e.preventDefault?.();
                    e.stopPropagation?.();
                    setTextValue(defaultValue + '');
                    setSliderValue(defaultValue);
                    sliderRef.current?._reactInternals?.stateNode?.setState?.({ value: defaultValue });
                    onChange(defaultValue);
                  },
                  children: '\u21ba'
                })
              : null,
            jsx(TextInputComponent, {
              inputRef,
              value: textValue,
              rows: 1,
              className: "DynamicBackgrounds-NumberInput",
              disabled: restProps.disabled,
              id: ID,
              onChange: handleTextChange,
              onBlur: onTextCommit,
              onKeyDown: handleKeyDown,
            }),
            restProps.suffix ? jsx('span', { children: restProps.suffix }) : null
          ]
        }), jsx("div", {
          children: jsx(MenuSliderControlComponent, {
            ref: sliderRef,
            mini: true, className: constants.slider?.slider,
            disabled: restProps.disabled,
            initialValue: sliderValue,
            onValueRender: e => Number(e.toFixed(restProps.decimals ?? 0)) + (restProps.suffix ?? ''),
            minValue: restProps.minValue,
            maxValue: restProps.maxValue,
            onValueChange: onSliderCommit,
            asValueChanges: handleSliderChange,
            keyboardStep: restProps.decimals ? Math.pow(10, -1 * restProps.decimals + 1) : 1
          })
        })
      ]
    })
  }

  function InPopoutSettings({ rerender = () => {} }) {
    const [settings, setSettings] = useSettings();
    const handleClick = useCallback(e => {
      const MyContextMenu = ContextMenu.buildMenu([
        { type: 'separator' },
        {
          label: "Enable transition",
          type: 'toggle',
          checked: settings.transition.enabled,
          action: () => {
            setSettings(prev => ({ ...prev, transition: { ...prev.transition, enabled: !prev.transition.enabled } }));
            viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (settings.transition.enabled ? settings.transition.duration ?? 0 : 0) + 'ms');
          }
        }, {
          label: "Transition duration",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            disabled: !settings.transition.enabled,
            label: "Transition duration",
            value: settings.transition.duration,
            minValue: 0, maxValue: 3000,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, duration: Number(newVal) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-transition-duration', (settings.transition.enabled ? Number(newVal) ?? 0 : 0) + 'ms');
            },
            suffix: " ms"
          })),
        }, {
          type: 'group',
          items: [{
            label: "Enable slideshow",
            type: 'toggle',
            checked: settings.slideshow.enabled,
            action: () => {
              setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, enabled: !prev.slideshow.enabled } }));
              settings.slideshow.enabled ? slideShowManager.stop() : slideShowManager.start();
              rerender(e => [...e]);
            }
          }, {
            label: "Slideshow interval",
            type: "custom",
            render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
              disabled: !settings.slideshow.enabled,
              label: "Slideshow interval",
              value: settings.slideshow.interval / 1000,
              minValue: 1, maxValue: 600,
              decimals: 0,
              onChange: newVal => {
                const oldValue = settings.slideshow.interval;
                setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, interval: Number(newVal) * 1000 } }));
                if (oldValue !== newVal * 1000) slideShowManager.start();
              },
              suffix: " sec"
            })),
          }, {
            label: "Shuffle order",
            type: 'toggle',
            checked: settings.slideshow.shuffle,
            action: () => setSettings(prev => ({ ...prev, slideshow: { ...prev.slideshow, shuffle: !prev.slideshow.shuffle } }))
          }]
        }, { type: 'separator', }, {
          /* Untermenue statt <select>: ein natives Dropdown wird vom Betriebssystem
             gezeichnet (kein Theme-Styling moeglich) und schliesst sich, weil das
             Kontextmenue mousedown abfaengt. */
          label: 'Transition effect',
          type: 'submenu',
          items: Object.entries(transitionTypes).map(([value, label]) => ({
            label,
            type: 'radio',
            checked: (settings.transition.type || 'fade') === value,
            action: () => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, type: value } }));
              try { viewTransition.bgContainer()?.setAttribute('data-transition', value); } catch (err) {}
              try { viewTransition.setProperty?.(); } catch (err) {}
              try { UI.showToast('Transition: ' + label, { type: 'success' }); } catch (err) {}
              /* Das Menue wird beim Oeffnen einmal aufgebaut, "checked" ist also eine
                 Momentaufnahme. Deshalb schliessen statt neu zeichnen. */
              try { ContextMenu.close(); } catch (err) {}
            }
          }))
        }, {
          /* Zweite, unabhaengige Auswahl. Der Uebergang bestimmt WIE gewechselt
             wird, der Dauereffekt liegt permanent auf dem Bild - beides frei
             kombinierbar. Frueher steckten beide Arten in derselben Liste,
             weshalb ein "Ken Burns" den Bildwechsel gar nicht beeinflusst hat. */
          label: 'Ambient effect',
          type: 'submenu',
          items: Object.entries(ambientTypes).map(([value, label]) => ({
            label,
            type: 'radio',
            checked: (settings.transition.ambient || 'none') === value,
            action: () => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, ambient: value } }));
              try { viewTransition.bgContainer()?.setAttribute('data-ambient', value); } catch (err) {}
              try { UI.showToast('Ambient effect: ' + label, { type: 'success' }); } catch (err) {}
              try { ContextMenu.close(); } catch (err) {}
            }
          }))
        }, {
          label: 'Ambient effect speed',
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Speed",
            value: settings.transition.ambientSpeed ?? 100,
            defaultValue: defaultSettings.transition.ambientSpeed,
            minValue: 10, maxValue: 600,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, transition: { ...prev.transition, ambientSpeed: newVal } }));
              applyAmbientSpeed(newVal);
            },
            /* onSlide wirkt live beim Ziehen - bewusst nur die CSS-Variable und
               nicht applyAmbientSpeed: die Keyframes waehrend des Ziehens neu zu
               schreiben wuerde die laufende Animation staendig neu starten. */
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-ambient-factor', String(100 / (newVal || 100))),
            suffix: '%'
          })),
        }, { type: 'separator' }, {
          label: 'Dimming',
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Dimming",
            value: settings.adjustment.dimming,
            defaultValue: defaultSettings.adjustment.dimming,
            minValue: 0, maxValue: 1,
            decimals: 2,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, dimming: newVal } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-dimming', newVal);
            },
            onSlide: newVal => viewTransition.bgContainer()?.style.setProperty('--BgManager-dimming', newVal),
            suffix: ''
          })),
        }, {
          label: "Blur",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Blur",
            value: settings.adjustment.blur,
            defaultValue: defaultSettings.adjustment.blur,
            minValue: 0, maxValue: 100,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, blur: Math.min(100, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-blur', Math.min(100, Math.max(0, newVal)) + 'px'); viewTransition.setFxFlags();
            },
            onSlide: newVal => { viewTransition.bgContainer()?.style.setProperty('--BgManager-blur', Math.min(100, Math.max(0, newVal)) + 'px'); viewTransition.setFxFlags(); },
            suffix: ' px'
          })),
        }, {
          label: "Grayscale",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Grayscale",
            value: settings.adjustment.grayscale,
            defaultValue: defaultSettings.adjustment.grayscale,
            minValue: 0, maxValue: 100,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, grayscale: Math.min(100, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-grayscale', Math.min(100, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags();
            },
            onSlide: newVal => { viewTransition.bgContainer()?.style.setProperty('--BgManager-grayscale', Math.min(100, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags(); },
            suffix: ' %'
          })),
        }, {
          label: "Saturation",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Saturation",
            value: settings.adjustment.saturate,
            defaultValue: defaultSettings.adjustment.saturate,
            minValue: 0, maxValue: 300,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, saturate: Math.min(300, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-saturation', Math.min(300, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags();
            },
            onSlide: newVal => { viewTransition.bgContainer()?.style.setProperty('--BgManager-saturation', Math.min(300, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags(); },
            suffix: ' %'
          })),
        }, {
          label: "Contrast",
          type: "custom",
          render: () => jsx(ErrorBoundary, null, jsx(MenuNumberInput, {
            label: "Contrast",
            value: settings.adjustment.contrast,
            defaultValue: defaultSettings.adjustment.contrast,
            minValue: 0, maxValue: 300,
            decimals: 0,
            onChange: newVal => {
              setSettings(prev => ({ ...prev, adjustment: { ...prev.adjustment, contrast: Math.min(300, Math.max(0, newVal)) } }));
              viewTransition.bgContainer()?.style.setProperty('--BgManager-contrast', Math.min(300, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags();
            },
            onSlide: newVal => { viewTransition.bgContainer()?.style.setProperty('--BgManager-contrast', Math.min(300, Math.max(0, newVal)) + '%'); viewTransition.setFxFlags(); },
            suffix: ' %'
          })),
        }
      ]);
      ContextMenu.open(e, MyContextMenu);
    }, [settings]);

    return jsx(BarButton, {
      label: 'Open Settings',
      path: BAR_ICONS.gear,
      onClick: handleClick
    })
  }

  // Patching functions
  /** Context menu un-/patcher */
  const contextMenuPatcher = function () {
    let cleanupImage, cleanupMessage;
    function patch() {
      if (!cleanupImage) {
        // image modal
        cleanupImage = ContextMenu.patch('image-context', (menu, context) => {
          if (context.target.tagName === 'IMG') {
            menu.props.children.splice(menu.props.children.length, 0, BuildMenuItem(context.src));
          }
        });
      }
      if (!cleanupMessage) {
        cleanupMessage = ContextMenu.patch('message', (menu, context) => {
          let embed;
          if (
            context.target.classList.contains(constants.originalLink?.originalLink) &&
            context.target.dataset.role === 'img' &&
            Array.isArray(menu?.props?.children?.props?.children)
          ) {
            if (context.mediaItem?.contentType?.startsWith('image')) {
              // uploaded image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(context.mediaItem.url))
            } else if ((embed = context.message.embeds?.find(e => e.image?.url === context.target.href))) {
              // linked image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.image.proxyURL))
            } else if ((embed = context.message.messageSnapshots[0].message.embeds?.find(e => e.image?.url === context.target.href))) {
              // forwarded linked image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.image.proxyURL))
            } else if ((embed = context.message.messageSnapshots[0].message.attachments?.find(e => e.url === context.target.href))) {
              // forwarded uploaded image
              menu.props.children.props.children.splice(-1, 0, BuildMenuItem(embed.proxy_url))
            }
          }
        })
      }
    }
    function unpatch() {
      cleanupImage?.();
      cleanupImage = null;
      cleanupMessage?.();
      cleanupMessage = null;
    }
    function BuildMenuItem(src) {
      return jsx(ContextMenu.Group, null, jsx(ContextMenu.Item, {
        id: 'add-Manager',
        label: 'Add to DynamicBackgrounds',
        action: async () => {
          let mediaURL = function (src) {
            let safeURL = function (url) { try { return new URL(url) } catch (e) { return null } }(src);
            return null == safeURL || safeURL.host === "cdn.discordapp.com" ? src : safeURL.origin === "https://media.discordapp.net" ? (safeURL.host = "cdn.discordapp.com",
              ["size", "width", "height", "quality", "format"].forEach(param => safeURL.searchParams.delete(param)),
              safeURL.toString()) : (safeURL.searchParams.delete("width"),
                safeURL.searchParams.delete("height"),
                safeURL.toString())
          }(src);
          try {
            const response = await fetch(new Request(mediaURL, { method: "GET", mode: "cors" }));
            if (!response.ok) throw new Error(response.status);
            if (!response.headers.get('Content-Type').startsWith('image/')) throw new Error('Item is not an image.');
            const blub = await response.blob();
            const thumb = await makeThumb(blub);
            const image = new Image();
            image.onload = () => setImageFromIDB(storedImages => {
              storedImages.push({ id: naechsteId(storedImages), image: blub, thumb, width: image.width, height: image.height, selected: false, src: null });
              clearObjectURL(image);
              UI.showToast("Successfully added to DynamicBackgrounds", { type: 'success' });
            });
            image.onerror = () => clearObjectURL(image);
            setObjectURL(image, blub);
          } catch (err) {
            console.error('Status ', err)
            UI.showToast("Could not add. Status " + err, { type: 'error' });
          };
        }, icon: s => jsx('svg', {
          className: s.className,
          'aria-hidden': 'true',
          role: 'img',
          xmlns: "http://www.w3.org/2000/svg",
          width: "16",
          height: "16",
          viewBox: "0 0 24 24",
          children: jsx('path', {
            fill: "currentColor",
            d: "M19 10v7h-12v-12h7v-2h-7c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-7zM10.5 12.67l1.69 2.26 2.48-3.1 3.33 4.17h-10zM1 7v14c0 1.1.9 2 2 2h14v-2H4V7zM21 3v-3h-2v3h-3c.01.01 0 2 0 2h3v2.99c.01.01 2 0 2 0v-2.99h3v-2z"
          })
        })
      }))
    }

    return { patch, unpatch }
  }();

  /** Patches the button to the HeaderBar */
  function addButton() {
    if (constants.settings.addContextMenu) contextMenuPatcher.patch();
    try {
      // patch image Modal to be able to show blobs as well
      const filter2 = m => m instanceof Function && (str => ['"disable-adaptive-theme":'].every(s => str.includes(s)))(m.toString());
      const getSrcModule = Webpack.getModule(m => Object.values(m).some(filter2));
      if (!getSrcModule) throw new Error("Cannot find src module");
      const getSrcKey = Object.keys(getSrcModule).find(key => filter2(getSrcModule[key]));
      if (!getSrcKey) throw new Error("Cannot find src module key");
      Patcher.after(meta.slug, getSrcModule, getSrcKey, (_, args) => {
        if (args[0]?.src?.startsWith?.('blob:'))
          return args[0].src;
      })
    } catch (e) {
      console.error('%c[DynamicBackgrounds]%c ', e, "color:#DBDCA6;font-weight:bold", "")
    }
    // patch headerbar
    try {
      const filter = module => module?.Icon && module.Title && module.toString().includes('section');
      const HeaderBarModule = Webpack.getModule(m => Object.values(m).some(filter));
      if (!HeaderBarModule) throw new Error("Cannot find toolbar module");
      const headerBarKey = Object.keys(HeaderBarModule).find(key => filter(HeaderBarModule[key]));
      if (!headerBarKey) throw new Error("Cannot find toolbar module key");
      Patcher.before(meta.slug, HeaderBarModule, headerBarKey, (_, args) => {
        // Check if toolbar children exists and if its an Array. Also, check if our component is already there.
        if (Array.isArray(args[0]?.toolbar?.props?.children) && !args[0].toolbar.props.children.some?.(e => e?.key === meta.slug))
          // Render the component behind the search bar.
          args[0].toolbar.props.children.splice(-2, 0, jsx(ErrorBoundary, {
            children: jsx(PopoutComponent), key: meta.slug
          }));
      })
    } catch (e) {
      console.error('%c[DynamicBackgrounds] %cCould not patch the HeaderBar - the toolbar icon will not appear, but the rest of the plugin still works. Discord likely changed the internal toolbar module.', "color:#DBDCA6;font-weight:bold", "", e);
    }
    forceRerenderElement('.' + constants.toolbarClasses?.toolbar);
  }

  /** Cleanup when plugin is disabled */
  function stop() {
    // Sonst schlaegt die Update-Pruefung noch zu, nachdem das Plugin aus ist.
    clearTimeout(updateTimer);
    updateTimer = null;

    let db;
    // On unmount, check if there are any selected images inside the database, and if so, revoke the URL and remove URL from the database.
    openDB('images').then(database => {
      db = database;
      return getAllItems(db, 'images');
    }).then(storedItems => {
      storedItems.forEach(e => {
        clearObjectURL(e);
        e.src = null;
      });
      saveItems(db, 'images', storedItems, storedItems);
    }).catch(err => {
      console.error('Error opening database:', err);
    }).finally(() => {
      db?.close();
    });
    // destroy any slideshows, mutation observer and image containers
    slideShowManager.stop();
    themeObserver.stop();
    viewTransition.destroy();
    // remove the icon
    constants.toolbarClasses?.toolbar && forceRerenderElement('.' + constants.toolbarClasses?.toolbar);
    // unpatch contextmenu
    contextMenuPatcher.unpatch();
    // unpatch the toolbar
    Patcher.unpatchAll(meta.slug);
    // remove styles
    DOM.removeStyle(meta.slug + '-style');
    DOM.removeStyle(meta.slug + '-glitch');
    DOM.removeStyle('DynamicBackgrounds-background');
    DOM.removeStyle('DynamicBackgrounds-accent');
    DOM.removeStyle('DynamicBackgrounds-surfaces');
    /* Die Schluessel sind Objekt-URLs, die beim Abschalten widerrufen werden.
       Nach einem Neustart zeigen sie ins Leere, also hier leeren. */
    accentCache.clear();
    letzteAccentQuelle = null;
    /* Zwischengespeicherte Zustaende freigeben. _cachedImages haelt sonst alle
       Bilddaten im Speicher, obwohl das Plugin aus ist. */
    constants._cachedImages?.forEach(releaseSlideSrc);
    constants._cachedImages = null;
    constants._slideshowFavoritesOnly = null;
    constants._slideshowCategoryFilters = null;
  }

  /* ---- Eingebauter ZIP-Schreiber ----
     Keine Fremdbibliothek: die BD-Richtlinien verbieten zur Laufzeit geladene
     Bibliotheken. Kurz bleibt es, weil KEINE Komprimierung noetig ist - Bilder
     sind als WebP, JPEG oder PNG bereits komprimiert. Uebrig bleibt der reine
     Container. Unterordner entstehen durch Schraegstriche im Dateinamen. */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * @param {{name: string, data: Uint8Array}[]} entries
   * @returns {Blob} ZIP-Datei, unkomprimiert gespeichert (Methode 0)
   */
  function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const parts = [];      // Nutzdaten in Reihenfolge
    const central = [];    // Eintraege des Zentralverzeichnisses
    let offset = 0;

    // MS-DOS-Zeitstempel der aktuellen Zeit
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // Signatur
      local.setUint16(4, 20, true);           // benoetigte Version
      local.setUint16(6, 0x0800, true);       // Bit 11: Dateiname ist UTF-8
      local.setUint16(8, 0, true);            // Methode 0 = gespeichert
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); // komprimierte Groesse
      local.setUint32(22, data.length, true); // Originalgroesse
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);           // keine Zusatzfelder

      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);             // erzeugende Version
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint32(42, offset, true);        // Position des Dateikopfs
      central.push(new Uint8Array(dir.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);   // Eintraege auf diesem Datentraeger
    end.setUint16(10, entries.length, true);  // Eintraege insgesamt
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);          // Beginn des Zentralverzeichnisses

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // utility

  /** Wie lange ein einzelner Glitch-Ausbruch dauert - unabhaengig vom Abstand. */
  const GLITCH_BURST_MS = 450;
  /** Grundabstand zwischen zwei Ausbruechen bei Tempo 100%. */
  const GLITCH_BASE_PERIOD_MS = 6000;

  /**
   * Erzeugt die bm-glitch-Keyframes so, dass der Ausbruch immer gleich lang
   * bleibt und sich nur der Abstand davor aendert.
   *
   * Der Trick: Die Animation laeuft ueber die volle Periode, aber der Ausbruch
   * belegt davon nur den hinteren Teil - und zwar genau so viel Prozent, wie
   * GLITCH_BURST_MS an der aktuellen Periode ausmacht. Wird die Periode
   * kuerzer, waechst dieser Prozentanteil entsprechend mit, sodass der
   * Ausbruch in Sekunden gemessen gleich lang bleibt.
   */
  function updateGlitchKeyframes(speed) {
    const periodMs = GLITCH_BASE_PERIOD_MS * (100 / (speed || 100));
    // Bei sehr kurzen Perioden nicht mehr als 60% belegen, sonst geht die
    // Ruhephase verloren und es zuckt durchgehend.
    const burstPct = Math.min(60, Math.max(0.2, (GLITCH_BURST_MS / periodMs) * 100));
    const start = 100 - burstPct;
    const at = fraction => (start + burstPct * fraction).toFixed(3);

    DOM.addStyle(meta.slug + '-glitch', `
@keyframes bm-glitch {
  0%, ${start.toFixed(3)}% { transform: none; filter: none; }
  ${at(0.15)}% { transform: translate3d(-7px, 0, 0); filter: saturate(1.5) hue-rotate(8deg); }
  ${at(0.45)}% { transform: translate3d(6px, -2px, 0); filter: saturate(0.7); }
  ${at(0.70)}% { transform: translate3d(-3px, 1px, 0); filter: none; }
  ${at(1)}%, 100% { transform: none; filter: none; }
}`);
  }

  /** Setzt Tempo-Variable und passende Glitch-Keyframes in einem Rutsch. */
  function applyAmbientSpeed(speed) {
    const value = speed || 100;
    viewTransition.bgContainer()?.style.setProperty('--BgManager-ambient-factor', String(100 / value));
    updateGlitchKeyframes(value);
  }

  /** Generates the main CSS for the plugin */
  function generateCSS() {
    DOM.removeStyle(meta.slug + '-style');
    DOM.addStyle(meta.slug + '-style', `
/* Gliederung: Variablen, Grundflaeche, Kopf, Werkzeugleiste, Raster und Stapel,
   Kacheln, Zustaende, Overlays, Einstellungen, Bewegung, danach die
   Hintergrundebene des Plugins (gehoert nicht zum Manager). */

/* ==========================================================================
   VARIABLEN
   ======================================================================== */

/* Die Akzentfarben sind als <color> registriert, nur dann kann eine Transition
   sie zwischen zwei Bildern ueberblenden. Eine unregistrierte Variable ist fuer
   den Browser Text und wechselt hart. */
@property --dbm-accent { syntax: '<color>'; inherits: true; initial-value: #ff4f9a; }
@property --dbm-accent-2 { syntax: '<color>'; inherits: true; initial-value: #8b5cf6; }
@property --dbm-on-accent { syntax: '<color>'; inherits: true; initial-value: #020204; }

/* Feste Farben, keine var(--background-*): das Plugin setzt Discords
   Hintergrundvariablen auf transparent, ein Rueckfallwert greift dann nicht.
   Ein Theme darf diese Variablen am Wurzelelement ueberschreiben. Die
   Einstellungsseite und das Menue am Zahnrad liegen ausserhalb des Managers
   und bekommen sie an ihrer eigenen Wurzel. */
.DynamicBackgrounds-popoutWrap,
.DynamicBackgrounds-settings,
.DynamicBackgrounds-menuRow {
  --dbm-surface: hsl(232 24% 7%);
  --dbm-surface-raised: hsl(232 20% 11%);
  --dbm-surface-hover: hsl(232 18% 15%);
  --dbm-line: rgba(255, 255, 255, 0.07);
  --dbm-text: #f4f5fa;
  --dbm-text-muted: rgba(244, 245, 250, 0.6);

  --dbm-radius-lg: 18px;
  --dbm-radius-md: 12px;
  --dbm-radius-full: 999px;

  /* Die Fallbacks gelten, solange noch kein Bild ausgewertet wurde. */
  --dbm-accent: var(--db-accent-1, #ff4f9a);
  --dbm-accent-2: var(--db-accent-2, #8b5cf6);
  --dbm-on-accent: var(--db-accent-1-contrast, #020204);

  /* Federnd mit leichtem Ueberschwingen fuer Hover und Klick, weich
     auslaufend fuer Ein- und Ausblenden. */
  --dbm-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dbm-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --dbm-dur-fast: 180ms;
  --dbm-dur: 300ms;

  transition: --dbm-accent 1.2s ease, --dbm-accent-2 1.2s ease, --dbm-on-accent 1.2s ease;
}

/* ==========================================================================
   GRUNDFLAECHE
   ======================================================================== */

.DynamicBackgrounds-popoutWrap {
  display: flex;
  align-items: flex-start;
  /* align to the right to match the Popout's align:'right' anchoring instead of centering,
     which was fighting the actual anchor position and causing the backdrop to render off to one side */
  justify-content: flex-end;
  padding: 12px 12px 8px 12px;
  /* Only the visible card (.DynamicBackgrounds-popoutInner) should catch clicks. The wrap itself
     can end up overlapping the toolbar icon above it; making it click-through here means the icon
     stays clickable (to close the popout) even where the wrap's invisible bounding box covers it. */
  pointer-events: none;
  background: none;
  box-shadow: none;
}
/* Safety net: Discord's own messagesPopoutWrap-xxxx class (still applied alongside ours for
   positioning/behavior compatibility) may carry its own background/shadow/backdrop-filter that
   would otherwise show through unpredictably. Force it off so only our own card renders visually. */
.DynamicBackgrounds-popoutWrap[class*="messagesPopoutWrap"] {
  background: none !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  /* Discords Klasse legt die Huelle auf 420px fest, der Manager ist breiter.
     Das Popout haengt mit der rechten Kante am Knopf; ist die Huelle schmaler
     als ihr Inhalt, ragt der Rest rechts aus dem Fenster. So breit wie der
     Inhalt waechst sie stattdessen nach links. */
  width: max-content;
  max-width: calc(100vw - 16px);
}

.DynamicBackgrounds-popoutInner {
  position: relative;
  width: min(760px, 92vw);
  max-height: min(calc(100vh - 96px), 80vh);
  /* Farbschein von oben links und schwaecher von unten rechts auf fester
     Grundfarbe. Kein backdrop-filter: bei laufendem Dauereffekt wuerde er in
     jedem Frame neu rechnen. */
  background:
    radial-gradient(ellipse 110% 90% at 0% 0%, color-mix(in srgb, var(--dbm-accent) 18%, transparent), transparent 56%),
    radial-gradient(ellipse 100% 80% at 100% 100%, color-mix(in srgb, var(--dbm-accent-2) 10%, transparent), transparent 56%),
    var(--dbm-surface);
  color: var(--dbm-text);
  border-radius: var(--dbm-radius-lg);
  padding: 0 10px 18px 10px;
  box-shadow: 0 0 0 1px var(--dbm-line), 0 28px 64px -10px rgba(0, 0, 0, 0.72);
  overflow: visible; /* popout itself stays fixed; gallery will scroll */
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

/* Helle Innenkante oben. Sie liegt auf einem eigenen Element ueber dem Kopf,
   weil ein inset-Schatten am Fenster vom Kopfbild verdeckt wuerde. */
.DynamicBackgrounds-popoutInner::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 3;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

/* Inhalt unter dem Kopf. Der Selektor ist doppelt, weil Discords Klassen am
   selben Element sonst gleichauf liegen. overflow bleibt sichtbar, damit die
   Kategorie-Liste ueber das Raster hinausragen darf; gescrollt wird im Raster. */
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-content {
  display: flex;
  flex-direction: column;
  overflow: visible;
  border: 0;
  /* Discords Klasse malt hier eine eigene Flaeche; die Grundfarbe des
     Fensters soll durchscheinen. */
  background: none;
}

/* ==========================================================================
   KOPF
   ======================================================================== */

/* Die Buehne: aktuelles Bild als weichgezeichneter Streifen. Das Bild wird
   einmal gezeichnet und steht dann still, es gibt keine Daueranimation. */
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-head {
  position: relative;
  flex: 0 0 auto;
  height: 152px;
  margin: 0 -10px 10px -10px;
  padding: 0 24px 0 26px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  overflow: hidden;
  border-radius: var(--dbm-radius-lg) var(--dbm-radius-lg) 0 0;
  background: var(--dbm-surface);
  color: var(--dbm-text);
  box-sizing: border-box;
  padding-bottom: 20px;
}

/* Zwei Bildebenen fuer die Ueberblendung. Die vordere (.on) blendet ueber der
   hinteren ein; die hintere bleibt dabei voll sichtbar und wird erst nach der
   Ueberblendung ausgeschaltet. Blenden beide gleichzeitig, wird es in der
   Mitte dunkel. inset negativ, damit der Rand der Weichzeichnung
   ausserhalb des Kopfes liegt. */
.DynamicBackgrounds-headBg {
  position: absolute;
  inset: -40px;
  z-index: 0;
  background-position: center;
  background-size: cover;
  filter: blur(22px) saturate(1.5) brightness(1.25);
  opacity: 0;
}
.DynamicBackgrounds-headBg.on {
  z-index: 1;
  opacity: 1;
}
/* Ausgeteilt: Das neue Bild kommt von rechts, leicht gedreht, und legt sich federnd
   ab; das alte wird nach links geschoben und blendet aus. Beide Animationen enden
   im Grundzustand (die Ebene ohne .on ist unsichtbar), es bleibt nichts stehen. */
.DynamicBackgrounds-headBg.deal,
.DynamicBackgrounds-headCard.deal { animation: DynamicBackgrounds-dealIn 640ms var(--dbm-ease-spring); }
.DynamicBackgrounds-headBg.out,
.DynamicBackgrounds-headCard.out { animation: DynamicBackgrounds-dealOut 420ms var(--dbm-ease-out); }
@keyframes DynamicBackgrounds-dealIn {
  from { opacity: 0; transform: translateX(110px) rotate(5deg) scale(1.04); }
}
@keyframes DynamicBackgrounds-dealOut {
  from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translateX(-70px) rotate(-4deg) scale(0.97); }
}

/* Kleine scharfe Vorschau des laufenden Bildes links neben dem Titel. */
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-head.hasCard { padding-left: 154px; }
.DynamicBackgrounds-headCards {
  position: absolute;
  left: 26px;
  bottom: 20px;
  z-index: 3;
  width: 104px;
  height: 66px;
  pointer-events: none;
}
.DynamicBackgrounds-headCard {
  position: absolute;
  inset: 0;
  border-radius: 9px;
  background-position: center;
  background-size: cover;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.28), 0 10px 22px -6px rgba(0, 0, 0, 0.7);
  rotate: -5deg;
  opacity: 0;
}
.DynamicBackgrounds-headCard.on { opacity: 1; }
.DynamicBackgrounds-headCard.deal { animation-name: DynamicBackgrounds-cardIn; }
@keyframes DynamicBackgrounds-cardIn {
  from { opacity: 0; transform: translateX(150px) rotate(16deg) scale(0.8); }
}

/* ==========================================================================
   FENSTER-SPIELEREIEN
   ========================================================================== */

/* Entfalten: Das Fenster waechst federnd aus der Ecke, in der der Knopf sitzt.
   Kopf, Leiste und die ersten Stapel steigen gestaffelt nach. Alle Keyframes
   haben nur einen Startwert, danach gilt wieder der normale Stil. */
.DynamicBackgrounds-popoutInner {
  isolation: isolate;
  transform-origin: 100% 0;
  animation: DynamicBackgrounds-unfold 420ms var(--dbm-ease-spring) backwards;
}
@keyframes DynamicBackgrounds-unfold {
  from { opacity: 0; transform: scale(0.72); }
}
.DynamicBackgrounds-popoutWrap.closing .DynamicBackgrounds-popoutInner {
  pointer-events: none;
  animation: DynamicBackgrounds-fold 200ms cubic-bezier(0.5, 0, 0.75, 0) forwards;
}
@keyframes DynamicBackgrounds-fold {
  to { opacity: 0; transform: scale(0.72); }
}
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-head { animation: DynamicBackgrounds-rise 380ms var(--dbm-ease-out) 110ms backwards; }
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-toolbar { animation: DynamicBackgrounds-rise 380ms var(--dbm-ease-out) 190ms backwards; }
.DynamicBackgrounds-categoryStack { animation: DynamicBackgrounds-rise 380ms var(--dbm-ease-out) calc(250ms + var(--rise-i, 0) * 45ms) backwards; }
.DynamicBackgrounds-categoryStack:nth-child(2) { --rise-i: 1; }
.DynamicBackgrounds-categoryStack:nth-child(3) { --rise-i: 2; }
.DynamicBackgrounds-categoryStack:nth-child(4) { --rise-i: 3; }
.DynamicBackgrounds-categoryStack:nth-child(5) { --rise-i: 4; }
.DynamicBackgrounds-categoryStack:nth-child(6) { --rise-i: 5; }
.DynamicBackgrounds-categoryStack:nth-child(n+7) { --rise-i: 6; }
@keyframes DynamicBackgrounds-rise {
  from { opacity: 0; translate: 0 14px; }
}

/* Farbwelle: ein Ring in der neuen Akzentfarbe, vom Abspielknopf aus. Er liegt
   in einer beschnittenen Ebene ueber dem Fenster und wird danach entfernt. */
.DynamicBackgrounds-wave {
  position: absolute;
  inset: 0;
  z-index: 4;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.DynamicBackgrounds-waveRing {
  position: absolute;
  left: var(--wave-x);
  top: var(--wave-y);
  width: calc(var(--wave-r) * 2);
  height: calc(var(--wave-r) * 2);
  margin: calc(var(--wave-r) * -1) 0 0 calc(var(--wave-r) * -1);
  border-radius: 50%;
  background: radial-gradient(circle closest-side,
    color-mix(in srgb, var(--db-accent-1, #ff4f9a) 10%, transparent) 40%,
    color-mix(in srgb, var(--db-accent-1, #ff4f9a) 60%, transparent) 82%,
    transparent 100%);
  animation: DynamicBackgrounds-wave 900ms cubic-bezier(0.22, 0.7, 0.3, 1) forwards;
}
@keyframes DynamicBackgrounds-wave {
  from { transform: scale(0.03); opacity: 1; }
  to { transform: scale(1); opacity: 0; }
}

/* Lichtschein unter der Maus. Die Klammer beschneidet an den Fensterecken, der
   Schein darin wandert nur per transform. */
.DynamicBackgrounds-glowClip {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.DynamicBackgrounds-glow {
  position: absolute;
  left: 0;
  top: 0;
  width: 440px;
  height: 440px;
  background: radial-gradient(circle closest-side, color-mix(in srgb, var(--dbm-accent) 22%, transparent), transparent);
  transform: translate3d(var(--glow-x, -600px), var(--glow-y, -600px), 0);
  animation: DynamicBackgrounds-glowIn 200ms ease-out;
}
@keyframes DynamicBackgrounds-glowIn {
  from { opacity: 0; }
}

/* Magnetische Knoepfe: translate folgt der Maus, beim Loslassen federt es zurueck. */
.DynamicBackgrounds-playWrap { transition: translate 320ms var(--dbm-ease-spring); }
.DynamicBackgrounds-headControls > .DynamicBackgrounds-headBtn { transition: transform var(--dbm-dur-fast) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease, color var(--dbm-dur-fast) ease, translate 320ms var(--dbm-ease-spring); }

.DynamicBackgrounds-headShade {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(8, 9, 14, 0.42) 0%, rgba(8, 9, 14, 0) 55%),
    linear-gradient(180deg, rgba(8, 9, 14, 0) 0%, rgba(8, 9, 14, 0.2) 45%, var(--dbm-surface) 100%);
}

.DynamicBackgrounds-headText,
.DynamicBackgrounds-headControls {
  position: relative;
  z-index: 3;
}

.DynamicBackgrounds-headText {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.DynamicBackgrounds-headEyebrow {
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dbm-text);
  opacity: 0.8;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
}
.DynamicBackgrounds-headTitle {
  margin: 0;
  font-size: 30px;
  font-weight: 800;
  line-height: 1.12;
  letter-spacing: -0.01em;
  color: var(--dbm-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
}
.DynamicBackgrounds-headMeta {
  min-height: 18px;
  font-size: 13px;
  line-height: 18px;
  color: var(--dbm-text-muted);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
}

.DynamicBackgrounds-headControls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.DynamicBackgrounds-headBtn {
  appearance: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: var(--dbm-radius-full);
  background: rgba(255, 255, 255, 0.12);
  color: var(--dbm-text);
  cursor: pointer;
  transition: transform var(--dbm-dur-fast) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease, color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-headBtn:hover { transform: scale(1.1); background: rgba(255, 255, 255, 0.2); }
.DynamicBackgrounds-headBtn:active { transform: scale(0.93); }
.DynamicBackgrounds-headBtn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.DynamicBackgrounds-headBtn[aria-pressed="true"] { background: var(--dbm-accent); color: var(--dbm-on-accent); }

.DynamicBackgrounds-headBtn.play {
  width: 56px;
  height: 56px;
  background: var(--dbm-accent);
  color: var(--dbm-on-accent);
  box-shadow: 0 6px 20px -4px color-mix(in srgb, var(--dbm-accent) 70%, transparent);
}
.DynamicBackgrounds-headBtn.play:hover { transform: scale(1.08); background: var(--dbm-accent); }

/* Der Ring sitzt auf einem Rahmen um den Knopf, damit Hover und Druck nur den
   Knopf skalieren und der Ring ruhig bleibt. */
.DynamicBackgrounds-playWrap {
  position: relative;
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
}
.DynamicBackgrounds-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
  pointer-events: none;
  overflow: visible;
}
.DynamicBackgrounds-ring circle {
  fill: none;
  stroke-width: 3;
}
.DynamicBackgrounds-ringTrack { stroke: rgba(255, 255, 255, 0.18); }
.DynamicBackgrounds-ringBar {
  stroke: var(--dbm-accent);
  stroke-linecap: butt;
  stroke-dasharray: 1 1;
  stroke-dashoffset: var(--ring-from, 1);
}
/* Nur im laufenden Zustand animiert. Die Startposition und Restdauer kommen
   aus der Diashow, der Ring zeigt also die echte Zeit bis zum Wechsel. */
.DynamicBackgrounds-ringBar.running {
  animation: DynamicBackgrounds-ring var(--ring-ms, 10000ms) linear forwards;
}
@keyframes DynamicBackgrounds-ring {
  from { stroke-dashoffset: var(--ring-from, 1); }
  to { stroke-dashoffset: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .DynamicBackgrounds-headBtn { transition: none; }
  .DynamicBackgrounds-headBtn:hover,
  .DynamicBackgrounds-headBtn:active { transform: none; }
  /* Entfalten wird ein kurzes Einblenden, Austeilen ein Ueberblenden; keine
     Welle (wird nicht erzeugt), kein Magnet, kein Schein (beide werden nicht angemeldet). */
  .DynamicBackgrounds-popoutInner { animation: DynamicBackgrounds-fadeIn 150ms linear backwards; }
  .DynamicBackgrounds-popoutInner .DynamicBackgrounds-head,
  .DynamicBackgrounds-popoutInner .DynamicBackgrounds-toolbar,
  .DynamicBackgrounds-categoryStack { animation: none; }
  .DynamicBackgrounds-headBg.deal,
  .DynamicBackgrounds-headCard.deal { animation: DynamicBackgrounds-fadeIn 400ms linear; }
  .DynamicBackgrounds-headBg.out,
  .DynamicBackgrounds-headCard.out { animation: DynamicBackgrounds-fadeOut 400ms linear; }
  .DynamicBackgrounds-headControls > .DynamicBackgrounds-headBtn,
  .DynamicBackgrounds-playWrap { transition: none; }
}
@keyframes DynamicBackgrounds-fadeIn { from { opacity: 0; } }
@keyframes DynamicBackgrounds-fadeOut { to { opacity: 0; } }

/* ==========================================================================
   WERKZEUGLEISTE
   ======================================================================== */

/* Eine Reihe direkt unter dem Kopf. Flaechen werden beim Ueberfahren eine
   Stufe heller, runde Knoepfe federn. Keine Trennlinie: die Leiste setzt sich
   durch Abstand und gefuellte Flaechen vom Raster ab. */
.DynamicBackgrounds-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 12px 16px 2px;
}

/* Segmentschalter: Spur als Pille, der Daumen in Akzentfarbe gleitet zum
   gewaehlten Segment. Beide Segmente sind gleich breit, damit der Daumen sich
   ueber eine reine Verschiebung um seine eigene Breite bewegen kann. */
.DynamicBackgrounds-seg {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 4px;
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dbm-line);
}
.DynamicBackgrounds-segThumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc(50% - 4px);
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-accent);
  box-shadow: 0 4px 14px -4px var(--dbm-accent);
  transform: translateX(0);
  transition: transform 420ms var(--dbm-ease-spring);
}
.DynamicBackgrounds-seg[data-pos="1"] .DynamicBackgrounds-segThumb {
  transform: translateX(100%);
}
.DynamicBackgrounds-segBtn {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--dbm-radius-full);
  background: none;
  color: var(--dbm-text-muted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-segBtn:hover { color: var(--dbm-text); }
.DynamicBackgrounds-segBtn.on,
.DynamicBackgrounds-segBtn.on:hover { color: var(--dbm-on-accent); }

/* Kategorie-Feld: Pille mit Ordnersymbol, Beschriftung und Pfeil. */
.DynamicBackgrounds-quickWrap {
  position: relative;
  flex: 1 1 0;
  min-width: 130px;
  max-width: 280px;
}
.DynamicBackgrounds-field {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px 0 14px;
  border: 0;
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dbm-line);
  color: var(--dbm-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--dbm-dur-fast) ease, box-shadow var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-field:hover,
.DynamicBackgrounds-field.open { background: var(--dbm-surface-hover); }
.DynamicBackgrounds-field.filtered .DynamicBackgrounds-fieldIcon { color: var(--dbm-accent); }
.DynamicBackgrounds-fieldIcon { flex: 0 0 auto; color: var(--dbm-text-muted); }
.DynamicBackgrounds-fieldText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.DynamicBackgrounds-fieldArrow {
  flex: 0 0 auto;
  color: var(--dbm-text-muted);
  transition: transform var(--dbm-dur) var(--dbm-ease-spring);
}
.DynamicBackgrounds-field.open .DynamicBackgrounds-fieldArrow { transform: rotate(180deg); }

/* Liste: erhoehte dunkle Flaeche, sanftes Aufklappen aus opacity und
   transform. Die Animation startet beim Einhaengen, also nur nach einem Klick. */
.DynamicBackgrounds-quickMenu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 100%;
  max-width: 340px;
  max-height: 280px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
  padding: 6px;
  box-sizing: border-box;
  border-radius: var(--dbm-radius-lg);
  background: var(--dbm-surface-raised);
  color: var(--dbm-text);
  box-shadow: 0 0 0 1px var(--dbm-line), 0 18px 40px -8px rgba(0, 0, 0, 0.75);
  z-index: 30;
  font-size: 14px;
  transform-origin: 24px 0;
  animation: DynamicBackgrounds-menuIn 260ms var(--dbm-ease-out);
}
@keyframes DynamicBackgrounds-menuIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
.DynamicBackgrounds-quickMenuItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--dbm-radius-md);
  cursor: pointer;
  outline: none;
  transition: background-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-quickMenuItem:hover,
.DynamicBackgrounds-quickMenuItem:focus-visible { background: var(--dbm-surface-hover); }
.DynamicBackgrounds-quickMenuItem:focus-visible { box-shadow: inset 0 0 0 2px var(--dbm-accent); }
.DynamicBackgrounds-quickMenuText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.DynamicBackgrounds-quickCheck { flex: 0 0 auto; color: var(--dbm-accent); opacity: 0; }
.DynamicBackgrounds-quickMenuItem.on { color: var(--dbm-accent); font-weight: 700; }
.DynamicBackgrounds-quickMenuItem.on .DynamicBackgrounds-quickCheck { opacity: 1; }

/* Rechts die runden Knoepfe. Der erste (Bilder hinzufuegen) ist gefuellt. */
.DynamicBackgrounds-toolEnd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.DynamicBackgrounds-barBtn {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--dbm-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dbm-line);
  color: var(--dbm-text-muted);
  cursor: pointer;
  transition: transform var(--dbm-dur) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease, color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-barBtn:hover {
  background: var(--dbm-surface-hover);
  color: var(--dbm-text);
  transform: scale(1.1);
}
.DynamicBackgrounds-barBtn:active { transform: scale(0.92); }
.DynamicBackgrounds-barBtn.primary {
  background: var(--dbm-accent);
  color: var(--dbm-on-accent);
  box-shadow: 0 4px 14px -4px var(--dbm-accent);
}
.DynamicBackgrounds-barBtn.primary:hover { filter: brightness(1.12); }

/* Sichtbarer Fokus fuer alle Bedienelemente der Leiste */
.DynamicBackgrounds-barBtn:focus-visible,
.DynamicBackgrounds-field:focus-visible,
.DynamicBackgrounds-segBtn:focus-visible,
.DynamicBackgrounds-chip:focus-visible,
.DynamicBackgrounds-addTile:focus-visible {
  outline: 2px solid var(--dbm-accent);
  outline-offset: 2px;
}

/* Zeile innerhalb einer Kategorie: zurueck und loeschen */
.DynamicBackgrounds-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dbm-line);
  color: var(--dbm-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: transform var(--dbm-dur) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-chip:hover {
  background: var(--dbm-surface-hover);
  transform: translateX(-2px);
}

.DynamicBackgrounds-categoryBar {
  display: flex;
  gap: 8px;
  padding: 0 12px 6px 2px;
  align-items: center;
}

.DynamicBackgrounds-categoryButton {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--dbm-surface-raised);
  color: var(--dbm-text);
  font-size: 18px;
  cursor: pointer;
  transition: transform var(--dbm-dur) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-categoryButton:hover {
  background: var(--dbm-surface-hover);
  transform: scale(1.1);
}
.DynamicBackgrounds-categoryButton.delete {
  background: #c62828;
  color: #fff;
}
.DynamicBackgrounds-categoryButton.delete:hover {
  background: #d15353;
}
.DynamicBackgrounds-categoryInputRow {
  display: flex;
  gap: 8px;
  padding: 0 12px 10px 2px;
}
.DynamicBackgrounds-categoryInput {
  flex: 1;
  height: 36px;
  padding: 0 14px;
  border-radius: var(--dbm-radius-full);
  border: none;
  background: var(--dbm-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dbm-line);
  color: var(--dbm-text);
  font-size: 14px;
  outline: none;
}
.DynamicBackgrounds-categoryInput:focus {
  box-shadow: inset 0 0 0 2px var(--dbm-accent);
}


/* ==========================================================================
   RASTER UND STAPEL
   ======================================================================== */

.DynamicBackgrounds-gridWrapper {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  flex: 1 1 auto;
  overflow: auto; /* gallery/groups area scrolls */
  max-height: min(calc(100vh - 216px), 60vh); /* leave space for header and controls, scaled with viewport instead of a fixed offset */
  padding: 12px;
  margin-bottom: 0.5rem;
  box-sizing: border-box;
  align-content: start;
  transform: translateZ(0); /* promote layer to reduce scroll jank */
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
  mask-image: linear-gradient(#0000, #000 0.5rem, #000 calc(100% - 0.5rem), #0000 100%), linear-gradient(to left, #000 0.75rem, #0000 0.75rem);
}

/* Jedes direkte Kind (Stapel oder Bildkachel) bekommt dieselbe Huelle. */
.DynamicBackgrounds-gridWrapper > * {
  padding: 6px;
  box-sizing: border-box;
  min-height: 100px;
  margin-bottom: 12px;
}

.DynamicBackgrounds-gridWrapper::-webkit-scrollbar {
  width: 10px;
}
.DynamicBackgrounds-gridWrapper::-webkit-scrollbar-track {
  background: rgba(0,0,0,0.12);
  border-radius: 10px;
}
.DynamicBackgrounds-gridWrapper::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  border: 2px solid rgba(0,0,0,0.18);
}
.DynamicBackgrounds-gridWrapper::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.12);
}

/* Kachel hebt sich beim Ueberfahren leicht an (siehe Zustaende). Bewegung
   erzeugt mehr Wertigkeit als jeder Schein - und transform kostet nichts,
   weil es ausschliesslich auf der GPU laeuft. Steht nach der Huelle oben,
   damit min-height: 0 dort gewinnt. */
.DynamicBackgrounds-categoryStack {
  position: relative;
  overflow: visible;   /* die Faecherung darf seitlich ueberstehen */
  min-height: 0;
  cursor: pointer;
  border-radius: 10px;
  transition: transform 180ms cubic-bezier(0.22,0.61,0.36,1), background-color 180ms ease;
}

/* Die Faecherflaeche der Karten. Klicks sollen die Kachel treffen, nicht das
   Einzelbild, daher pointer-events: none (die Karten schalten es wieder ein). */
.DynamicBackgrounds-stackFan {
  position: relative;
  display: block;
  height: 176px;
  box-sizing: border-box;
  pointer-events: none;
  /* Neigung zur Maus: --tilt-x/--tilt-y setzt das Skript auf dem Stapel. Der
     Faecher traegt sie, nicht die Karten, damit deren transform und Keyframes
     unberuehrt bleiben. Beim Verlassen federt er zurueck. */
  transform: perspective(760px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg));
  transform-origin: 50% 85%;
  transition: transform 620ms var(--dbm-ease-spring);
}
.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-stackFan,
.DynamicBackgrounds-addTile:hover .DynamicBackgrounds-stackFan {
  transition: transform 140ms var(--dbm-ease-out);
}

/* Lichtschein unter dem Stapel. Statisch (Verlauf statt Filter); beim Hover
   werden nur opacity und transform uebergeblendet. */
.DynamicBackgrounds-stackFan::before {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -18px;
  width: 250px;
  height: 84px;
  margin-left: -125px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--dbm-accent) 62%, transparent), transparent);
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 320ms var(--dbm-ease-out), transform 420ms var(--dbm-ease-spring);
  pointer-events: none;
}
.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-stackFan::before,
.DynamicBackgrounds-addTile:hover .DynamicBackgrounds-stackFan::before {
  opacity: 0.85;
  transform: scale(1);
}

/* Plakette mit der Bildanzahl an der oberen rechten Ecke des Stapels. */
.DynamicBackgrounds-stackBadge {
  position: absolute;
  top: -6px;
  left: calc(50% + 103px);
  transform: translateX(-100%);
  z-index: 500;
  min-width: 22px;
  box-sizing: border-box;
  padding: 2px 8px;
  border-radius: var(--dbm-radius-full);
  background: rgba(8, 9, 18, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--dbm-text-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  transition: background-color var(--dbm-dur-fast) ease, color var(--dbm-dur-fast) ease, border-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-stackBadge {
  background: var(--dbm-accent);
  border-color: transparent;
  color: var(--dbm-on-accent);
}

/* Position, Drehung, Tiefe, Deckkraft und Bewegung je Karte kommen als
   Inline-Style aus dem JSX, weil sie pro Karte berechnet werden. */
.DynamicBackgrounds-stackCard {
  position: absolute;
  left: 50%;
  bottom: 0;
  display: block;
  width: 190px;
  height: 120px;
  object-fit: cover;
  border-radius: 10px;
  /* Deutlich sichtbar, sonst verschwimmen aehnliche Bilder zu Streifen */
  border: 1px solid rgba(255,255,255,0.13);
  box-shadow: 0 10px 26px rgba(0,0,0,0.45);
  pointer-events: auto;
  will-change: transform;
  backface-visibility: hidden;
  transform-style: preserve-3d;
}
.DynamicBackgrounds-stackCard.is-queued {
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

/* Name und Anzahl unter dem Stapel, dauerhaft sichtbar. */
.DynamicBackgrounds-categoryLabel {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1.3;
}

.DynamicBackgrounds-categoryName {
  color: var(--dbm-text);
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ==========================================================================
   KACHELN
   ======================================================================== */

.DynamicBackgrounds-imageWrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-radius: var(--dbm-radius-md);
  background-color: #0000;
  flex: 0 0 calc(50% - 0.25rem);
  aspect-ratio: 16 / 9;
  outline: 2px solid transparent;
  outline-offset: 0;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  /* Die Neigung (transform) gibt es nur beim Hover; translate ist eine eigene
     Eigenschaft und hebt die Kachel, ohne die Neigung zu stoeren. */
  transition: outline-color 400ms cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 300ms ease,
              translate 360ms var(--dbm-ease-spring),
              transform 620ms var(--dbm-ease-spring);
  cursor: grab;
}
.DynamicBackgrounds-imageWrapper:active {
  cursor: grabbing;
}
/* Feine helle Innenkante, ueber dem Bild */
.DynamicBackgrounds-imageWrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  pointer-events: none;
}

.DynamicBackgrounds-image {
  display: block;
  width: 100%;
  height: 110px;
  object-fit: cover;
  min-height: 100%;
  min-width: 100%;
}
.DynamicBackgrounds-image.late {
  animation: fade-in 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Infos am unteren Rand: nur bei Hover und Fokus, als Pillen ueber einem
   weichen Verlauf. Oben liegen Herz, Marke und Loeschen, es gibt also keine
   Ueberlagerung. */
.DynamicBackgrounds-imageData {
  position: absolute;
  inset: auto 0 0;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 24px 8px 8px;
  background: linear-gradient(transparent, rgba(6, 7, 14, 0.72));
  opacity: 0;
  transform: translateY(5px);
  pointer-events: none;
  transition: opacity var(--dbm-dur-fast) ease, transform var(--dbm-dur-fast) var(--dbm-ease-out);
}
.DynamicBackgrounds-imageWrapper:is(:hover, :focus-visible, :focus-within) .DynamicBackgrounds-imageData {
  opacity: 1;
  transform: none;
}
.DynamicBackgrounds-imageData > span {
  padding: 1px 8px;
  border-radius: var(--dbm-radius-full);
  background: color-mix(in srgb, var(--dbm-surface) 90%, transparent);
  color: var(--dbm-text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* Laden: dunkler Platzhalter mit einem einzigen Schimmer je Ladevorgang.
   Danach bleibt er ruhig; ein endloses Schimmern waere Dauerbewegung. */
.DynamicBackgrounds-imageSkeleton {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--dbm-surface-raised);
}
.DynamicBackgrounds-imageSkeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.07) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: DynamicBackgrounds-sheen 1100ms var(--dbm-ease-out) 1 forwards;
}
@keyframes DynamicBackgrounds-sheen {
  to { transform: translateX(100%); }
}

/* Bildfehler: gestaltete Kachel statt rohem Text */
.DynamicBackgrounds-imageError {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--dbm-surface-raised);
  color: var(--dbm-text-muted);
  font-size: 12px;
  font-weight: 600;
}
.DynamicBackgrounds-imageError svg { opacity: 0.7; }

.DynamicBackgrounds-favoriteButton,
.DynamicBackgrounds-deleteButton {
  display: flex;
  position: absolute;
  z-index: 3;
  top: 8px;
  border: 0;
  padding: 4px;
  border-radius: var(--dbm-radius-full);
  color: #fff;
  opacity: 0;
  cursor: pointer;
  transition: background-color 150ms ease, opacity 250ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms ease, transform var(--dbm-dur) var(--dbm-ease-spring);
}
.DynamicBackgrounds-favoriteButton {
  left: 8px;
  background-color: rgba(8, 9, 18, 0.62);
}
.DynamicBackgrounds-deleteButton {
  right: 8px;
  background-color: #c62828;
}
/* Marke fuer das Bild, das gerade als Hintergrund laeuft */
.DynamicBackgrounds-nowBadge {
  position: absolute;
  z-index: 3;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 9px;
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-accent);
  color: var(--dbm-on-accent);
  font-size: 11px;
  font-weight: 800;
  line-height: 16px;
  letter-spacing: 0.02em;
  pointer-events: none;
}

/* Rueckfrage an der Kachel selbst */
.DynamicBackgrounds-confirm {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: inherit;
  background: rgba(6, 7, 14, 0.84);
  cursor: default;
  animation: DynamicBackgrounds-confirmIn 200ms var(--dbm-ease-out);
}
.DynamicBackgrounds-confirmText {
  color: var(--dbm-text);
  font-size: 13px;
  font-weight: 700;
}
.DynamicBackgrounds-confirmButtons {
  display: flex;
  gap: 8px;
}
.DynamicBackgrounds-confirmDelete,
.DynamicBackgrounds-confirmCancel {
  border: 0;
  padding: 6px 14px;
  border-radius: var(--dbm-radius-full);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform var(--dbm-dur-fast) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-confirmDelete {
  background: #d6403f;
  color: #fff;
}
.DynamicBackgrounds-confirmCancel {
  background: rgba(255, 255, 255, 0.14);
  color: var(--dbm-text);
}
.DynamicBackgrounds-confirmDelete:hover,
.DynamicBackgrounds-confirmCancel:hover {
  transform: scale(1.07);
}
.DynamicBackgrounds-confirmDelete:focus-visible,
.DynamicBackgrounds-confirmCancel:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
@keyframes DynamicBackgrounds-confirmIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ==========================================================================
   ZUSTAENDE
   ======================================================================== */

.DynamicBackgrounds-categoryStack:hover {
  transform: translateY(-3px);
}

.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-categoryName {
  color: var(--dbm-text);
}

/* Beim Ueberfahren leuchten alle Karten des Stapels, auch die verdeckten. */
.DynamicBackgrounds-categoryStack:hover img {
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45),
              0 0 16px 0 color-mix(in srgb, var(--dbm-accent) 30%, transparent);
}

/* Die Kategorie, aus der das aktuell laufende Bild stammt. Beantwortet auf
   der Uebersicht die Frage "wo laeuft es gerade her?", ohne ein einziges
   zusaetzliches Bedienelement. */
.DynamicBackgrounds-categoryStack.has-active .DynamicBackgrounds-categoryName::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 7px;
  vertical-align: middle;
  border-radius: 50%;
  background: var(--dbm-accent);
  box-shadow: 0 0 8px 1px color-mix(in srgb, var(--dbm-accent) 60%, transparent);
}

.DynamicBackgrounds-categoryStack.has-active img:last-of-type {
  outline: 1px solid rgba(255, 255, 255, 0.30);
  outline-offset: -1px;
}

/* Make stacks keyboard-focusable and show label on focus */
.DynamicBackgrounds-categoryStack:focus {
  outline: 2px solid var(--focus-primary, rgba(0,170,255,0.9));
  outline-offset: 2px;
}

/* Hover: federnd anheben, kraeftigerer Schatten, Neigung zur Maus (Variablen
   setzt das Skript). Die kurze Uebergangsdauer fuer transform laesst die
   Neigung der Maus folgen; beim Verlassen federt sie zurueck. */
.DynamicBackgrounds-imageWrapper:hover {
  translate: 0 -3px;
  transform: perspective(700px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg));
  transition: outline-color 400ms cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 300ms ease,
              translate 360ms var(--dbm-ease-spring),
              transform 140ms var(--dbm-ease-out);
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.55);
}
.DynamicBackgrounds-imageWrapper.dragging {
  opacity: 0.5;
  transform: scale(0.95);
}
.DynamicBackgrounds-imageWrapper.drag-over {
  outline-color: var(--green-430, #43b581);
  transform: scale(1.02);
}
/* Das aktive Bild: Ring in der Akzentfarbe. Statisch, ohne Daueranimation. */
.DynamicBackgrounds-imageWrapper.selected {
  outline-color: var(--dbm-accent);
  outline-offset: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3), 0 0 14px 1px color-mix(in srgb, var(--dbm-accent) 35%, transparent);
}
.DynamicBackgrounds-imageWrapper.selected:hover {
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.55), 0 0 14px 1px color-mix(in srgb, var(--dbm-accent) 35%, transparent);
}
.DynamicBackgrounds-imageWrapper:focus-visible {
  outline-color: #fff;
  outline-offset: 2px;
}

/* Knoepfe: bei Hover und bei Tastaturfokus auf der Kachel oder einem ihrer Knoepfe */
.DynamicBackgrounds-imageWrapper:is(:hover, :focus-within) > .DynamicBackgrounds-favoriteButton,
.DynamicBackgrounds-imageWrapper:is(:hover, :focus-within) > .DynamicBackgrounds-deleteButton,
.DynamicBackgrounds-favoriteButton:focus-visible,
.DynamicBackgrounds-deleteButton:focus-visible {
  opacity: 1;
}
.DynamicBackgrounds-imageWrapper.confirming > .DynamicBackgrounds-favoriteButton,
.DynamicBackgrounds-imageWrapper.confirming > .DynamicBackgrounds-deleteButton {
  visibility: hidden;
}
.DynamicBackgrounds-favoriteButton:is(:hover, :focus-visible),
.DynamicBackgrounds-deleteButton:is(:hover, :focus-visible) {
  transform: scale(1.12);
}
.DynamicBackgrounds-favoriteButton:focus-visible,
.DynamicBackgrounds-deleteButton:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
.DynamicBackgrounds-deleteButton:is(:hover, :focus-visible) {
  background-color: #d15353;
}
.DynamicBackgrounds-favoriteButton.active {
  opacity: 1;
  color: var(--dbm-accent);
  background-color: rgba(8, 9, 18, 0.78);
}
.DynamicBackgrounds-favoriteButton:is(:hover, :focus-visible) {
  background-color: rgba(8, 9, 18, 0.88);
  color: var(--dbm-accent);
}
.DynamicBackgrounds-favoriteButton.active svg {
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--dbm-accent) 70%, transparent));
}

/* Holo-Glanz: weicher Lichtfleck an der Mausposition plus schwacher
   diagonaler Regenbogenschimmer, beide als Verlaeufe. Das Overlay existiert
   nur beim Hover (content: none sonst), im Ruhezustand gibt es keine Ebene.
   Ohne mix-blend-mode: geringe Deckkraft reicht. */
.DynamicBackgrounds-imageWrapper:hover::after,
.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-stackFan::after {
  content: '';
  position: absolute;
  z-index: 4;
  border-radius: inherit;
  pointer-events: none;
  background:
    radial-gradient(circle at var(--holo-x, 50%) var(--holo-y, 50%), rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0) 55%),
    linear-gradient(115deg, rgba(255, 255, 255, 0) 18%, rgba(255, 90, 170, 0.16) 36%, rgba(255, 226, 90, 0.14) 45%, rgba(90, 235, 200, 0.16) 54%, rgba(120, 140, 255, 0.16) 63%, rgba(255, 255, 255, 0) 82%);
  background-size: 100% 100%, 260% 260%;
  background-position: 0 0, var(--holo-x, 50%) var(--holo-y, 50%);
  animation: DynamicBackgrounds-holoIn 220ms ease-out;
}
.DynamicBackgrounds-imageWrapper:hover::after {
  inset: 0;
}
/* Beim Stapel liegt das Overlay auf der vordersten Karte (190x120, 52px ueber dem Boden) */
.DynamicBackgrounds-categoryStack:hover .DynamicBackgrounds-stackFan::after {
  left: 50%;
  bottom: 52px;
  width: 190px;
  height: 120px;
  margin-left: -95px;
  border-radius: 10px;
  z-index: 600;
}
@keyframes DynamicBackgrounds-holoIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .DynamicBackgrounds-imageWrapper:hover { translate: none; }
}


/* ==========================================================================
   OVERLAYS
   ======================================================================== */

/* Hinzufuegen-Kachel am Ende des Rasters. Gestrichelter Rand und Plus; beim
   Ueberfahren wechseln beide auf die Akzentfarbe und die Kachel hebt sich. */
.DynamicBackgrounds-gridWrapper > .DynamicBackgrounds-addTile {
  display: block;
  position: relative;
  width: 100%;
  border: 0;
  background: none;
  color: var(--dbm-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--dbm-radius-md);
  transition: transform var(--dbm-dur) var(--dbm-ease-spring), color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-gridWrapper > .DynamicBackgrounds-addTile:not(.stack) {
  aspect-ratio: 16 / 9;
  align-self: start;
}
.DynamicBackgrounds-addTile:hover { transform: translateY(-3px); color: var(--dbm-accent); }
.DynamicBackgrounds-addFace {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: 2px dashed rgba(255, 255, 255, 0.2);
  border-radius: var(--dbm-radius-md);
  transition: border-color var(--dbm-dur-fast) ease, background-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-addTile:hover .DynamicBackgrounds-addFace,
.DynamicBackgrounds-categoryStack.is-empty:hover .DynamicBackgrounds-addFace {
  border-color: var(--dbm-accent);
  background: color-mix(in srgb, var(--dbm-accent) 8%, transparent);
}
/* In der Uebersicht hat die Kachel die Groesse eines Stapels: ein leerer
   Umriss in Kartengroesse und dahinter zwei schwache Umrisse, die einen
   Stapel andeuten. */
.DynamicBackgrounds-addTile .DynamicBackgrounds-addFace.stack,
.DynamicBackgrounds-categoryStack.is-empty .DynamicBackgrounds-addFace.stack {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 190px;
  height: 120px;
  transform: translateX(-50%);
  overflow: visible;
}
.DynamicBackgrounds-addFace.stack::before,
.DynamicBackgrounds-addFace.stack::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px dashed rgba(255, 255, 255, 0.1);
  border-radius: var(--dbm-radius-md);
  transition: border-color var(--dbm-dur-fast) ease;
  pointer-events: none;
}
.DynamicBackgrounds-addFace.stack::before { transform: translate(-11px, -26px) rotate(-2.6deg); }
.DynamicBackgrounds-addFace.stack::after { transform: translate(-22px, -52px) rotate(-5.2deg); opacity: 0.6; }
.DynamicBackgrounds-addTile:hover .DynamicBackgrounds-addFace.stack::before,
.DynamicBackgrounds-addTile:hover .DynamicBackgrounds-addFace.stack::after,
.DynamicBackgrounds-categoryStack.is-empty:hover .DynamicBackgrounds-addFace.stack::before,
.DynamicBackgrounds-categoryStack.is-empty:hover .DynamicBackgrounds-addFace.stack::after {
  border-color: color-mix(in srgb, var(--dbm-accent) 55%, transparent);
}
.DynamicBackgrounds-addTile .DynamicBackgrounds-categoryName { color: inherit; }
/* Der Glanz der Stapel liegt auf Karten; ein leerer Stapel hat keine. */
.DynamicBackgrounds-categoryStack.is-empty .DynamicBackgrounds-stackFan::after { display: none; }

/* Leere Sammlung und leere Kategorie: eine Ansicht ueber die ganze
   Rasterbreite. Die drei Umrisse haben die Form der Stapelkarten; im Ruhezustand
   steht alles still, beim Ueberfahren faechern sie sich auf. */
.DynamicBackgrounds-gridWrapper > .DynamicBackgrounds-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 0 6px;
  text-align: center;
  min-height: 0;
}
.DynamicBackgrounds-emptyCards {
  position: relative;
  width: 190px;
  height: 132px;
  margin-bottom: 16px;
}
.DynamicBackgrounds-emptyCards > span {
  position: absolute;
  inset: 6px 0 0;
  border: 2px dashed rgba(255, 255, 255, 0.18);
  border-radius: var(--dbm-radius-md);
  background: color-mix(in srgb, var(--dbm-accent) 4%, transparent);
  transition: transform 520ms var(--dbm-ease-spring), border-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-emptyCards > span:nth-child(1) { transform: translate(-22px, -8px) rotate(-8deg); opacity: 0.55; }
.DynamicBackgrounds-emptyCards > span:nth-child(2) { transform: translate(-11px, -4px) rotate(-4deg); opacity: 0.8; }
.DynamicBackgrounds-empty:hover .DynamicBackgrounds-emptyCards > span:nth-child(1) { transform: translate(-38px, -10px) rotate(-12deg); }
.DynamicBackgrounds-empty:hover .DynamicBackgrounds-emptyCards > span:nth-child(2) { transform: translate(-19px, -5px) rotate(-6deg); }
.DynamicBackgrounds-empty:hover .DynamicBackgrounds-emptyCards > span:nth-child(3) { border-color: color-mix(in srgb, var(--dbm-accent) 60%, transparent); }
.DynamicBackgrounds-emptyTitle {
  color: var(--dbm-text);
  font-size: 17px;
  font-weight: 800;
}
.DynamicBackgrounds-emptyHint {
  max-width: 420px;
  color: var(--dbm-text-muted);
  font-size: 13px;
  line-height: 1.4;
}
.DynamicBackgrounds-emptyButton {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 8px 18px 8px 14px;
  border: 0;
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-accent);
  color: var(--dbm-on-accent);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: transform var(--dbm-dur-fast) var(--dbm-ease-spring);
}
.DynamicBackgrounds-emptyButton:hover { transform: translateY(-2px) scale(1.04); }
.DynamicBackgrounds-emptyButton:active { transform: scale(0.97); }
.DynamicBackgrounds-emptyButton:focus-visible {
  outline: 2px solid var(--dbm-text);
  outline-offset: 2px;
}

/* Abdeckung beim Ziehen von Dateien ueber den Manager. Sie liegt im Fluss
   unsichtbar, faengt aber nur Ereignisse, solange sie an ist. */
.DynamicBackgrounds-popoutInner .DynamicBackgrounds-content { position: relative; }
.DynamicBackgrounds-dropOverlay {
  position: absolute;
  inset: 0 -10px -18px -10px;
  z-index: 40;
  display: grid;
  place-items: center;
  border-radius: 0 0 var(--dbm-radius-lg) var(--dbm-radius-lg);
  background: rgba(6, 7, 12, 0.88);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 260ms var(--dbm-ease-out), visibility 0s 260ms;
}
.DynamicBackgrounds-dropOverlay.on {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 200ms var(--dbm-ease-out), visibility 0s;
}
.DynamicBackgrounds-dropFrame {
  position: absolute;
  inset: 16px 22px 24px 22px;
  width: calc(100% - 44px);
  height: calc(100% - 40px);
  overflow: visible;
}
.DynamicBackgrounds-dropFrame rect {
  width: calc(100% - 3px);
  height: calc(100% - 3px);
  fill: color-mix(in srgb, var(--dbm-accent) 7%, transparent);
  stroke: var(--dbm-accent);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 12 12;
}
.DynamicBackgrounds-dropOverlay.on .DynamicBackgrounds-dropFrame rect {
  animation: DynamicBackgrounds-dropDash 1.2s linear infinite;
}
@keyframes DynamicBackgrounds-dropDash {
  to { stroke-dashoffset: -24; }
}
.DynamicBackgrounds-dropMsg {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--dbm-text);
}
.DynamicBackgrounds-dropPlus { color: var(--dbm-accent); }
.DynamicBackgrounds-dropOverlay.on .DynamicBackgrounds-dropPlus {
  animation: DynamicBackgrounds-dropPop 520ms var(--dbm-ease-spring) both;
}
@keyframes DynamicBackgrounds-dropPop {
  from { transform: scale(0.4); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.DynamicBackgrounds-dropText {
  font-size: 18px;
  font-weight: 800;
  max-width: 420px;
  text-align: center;
  overflow-wrap: anywhere;
}

.DynamicBackgrounds-popoutWrap:focus { outline: none; }

@media (prefers-reduced-motion: reduce) {
  .DynamicBackgrounds-stackFan { transform: none !important; transition: none !important; }
  .DynamicBackgrounds-stackFan::before { transform: none; transition: opacity 120ms linear; }
  .DynamicBackgrounds-seg .DynamicBackgrounds-segThumb,
  .DynamicBackgrounds-barBtn,
  .DynamicBackgrounds-addTile,
  .DynamicBackgrounds-emptyCards > span,
  .DynamicBackgrounds-emptyButton,
  .DynamicBackgrounds-imageData { transition: none; }
  .DynamicBackgrounds-imageSkeleton::after { animation: none; }
  .DynamicBackgrounds-quickMenu,
  .DynamicBackgrounds-dropOverlay.on .DynamicBackgrounds-dropFrame rect,
  .DynamicBackgrounds-dropOverlay.on .DynamicBackgrounds-dropPlus { animation: none; }
}

/* Export: Ansicht ueber dem ganzen Manager, in der Grundflaeche des Managers.
   Der Akzent steht nur auf dem Hauptknopf und dem Fortschrittsbalken. */
.DynamicBackgrounds-exportOverlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
  border-radius: var(--dbm-radius-lg);
  background: var(--dbm-surface);
  color: var(--dbm-text);
}
.DynamicBackgrounds-exportHead {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: var(--dbm-surface-raised);
  border-bottom: 1px solid var(--dbm-line);
}
.DynamicBackgrounds-exportTitle {
  margin: 0;
  color: var(--dbm-text);
  font-size: 17px;
  font-weight: 800;
}
.DynamicBackgrounds-exportActions {
  display: flex;
  gap: 8px;
}
.DynamicBackgrounds-exportButton {
  border: 0;
  border-radius: var(--dbm-radius-full);
  padding: 7px 16px;
  background: var(--dbm-surface-hover);
  color: var(--dbm-text);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: transform var(--dbm-dur-fast) var(--dbm-ease-spring), background-color var(--dbm-dur-fast) ease, opacity var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-exportButton:hover { transform: translateY(-1px) scale(1.03); }
.DynamicBackgrounds-exportButton:active { transform: scale(0.97); }
.DynamicBackgrounds-exportButton:focus-visible {
  outline: 2px solid var(--dbm-text);
  outline-offset: 2px;
}
.DynamicBackgrounds-exportButton:disabled { opacity: 0.6; cursor: default; transform: none; }
.DynamicBackgrounds-exportButton.primary {
  background: var(--dbm-accent);
  color: var(--dbm-on-accent);
}
/* Fortschritt: die Fuellung wird per transform gestreckt, das laeuft auf der
   Grafikkarte und gleitet zwischen den Schritten. */
.DynamicBackgrounds-exportProgress {
  position: absolute;
  inset: auto 0 -1px;
  height: 3px;
  overflow: hidden;
  background: var(--dbm-line);
}
.DynamicBackgrounds-exportProgressFill {
  height: 100%;
  background: var(--dbm-accent);
  transform-origin: left center;
  transition: transform 320ms var(--dbm-ease-out);
}
.DynamicBackgrounds-exportGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
  padding: 20px;
  overflow-y: auto;
  align-content: start;
}
.DynamicBackgrounds-exportCard {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--dbm-surface-raised);
  border-radius: var(--dbm-radius-md);
  padding: 10px;
  border: 1px solid var(--dbm-line);
}
.DynamicBackgrounds-exportThumb {
  width: 100%;
  height: 100px;
  object-fit: cover;
  border-radius: calc(var(--dbm-radius-md) - 4px);
  margin-bottom: 8px;
}
.DynamicBackgrounds-exportName {
  font-size: 12px;
  text-align: center;
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  color: var(--dbm-text-muted);
}
.DynamicBackgrounds-exportCard .DynamicBackgrounds-exportButton {
  padding: 5px 12px;
  font-size: 12px;
  width: 100%;
}

/* ==========================================================================
   EINSTELLUNGEN (Einstellungsseite und Menue am Zahnrad)
   ======================================================================== */

.DynamicBackgrounds-ResetButton {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border: none;
  border-radius: var(--dbm-radius-full);
  background: transparent;
  color: var(--dbm-text-muted);
  transition: color 120ms ease, background-color 120ms ease;
}
.DynamicBackgrounds-ResetButton:hover {
  color: var(--dbm-accent);
  background: color-mix(in srgb, var(--dbm-accent) 14%, transparent);
}
.DynamicBackgrounds-ResetButton:disabled {
  opacity: 0.4;
  cursor: default;
}
.DynamicBackgrounds-NumberInput::-webkit-scrollbar {
  display: none;
}
.DynamicBackgrounds-FormSwitch {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 4px 16px;
  margin-bottom: 20px;
  & label {
    display: contents;
    cursor: pointer;
  }
  &:has([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }
}
.DynamicBackgrounds-FormNumberInput {
  display: grid;
  grid-template-columns: 1fr 100px auto;
  align-items: center;
  gap: 4px;
  margin-bottom: 20px;
  &:has([disabled]) {
    opacity: 0.5;
  }
}
.DynamicBackgrounds-FormSelect {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 16px;
  margin-bottom: 20px;
  &:has([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }
}
.DynamicBackgrounds-Select {
  padding: 8px 12px;
  border-radius: var(--dbm-radius-md);
  background-color: var(--dbm-surface-raised);
  color: var(--dbm-text);
  border: none;
  cursor: pointer;
  font-size: 14px;
  min-width: 150px;
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 18px) calc(1em + 2px), calc(100% - 13px) calc(1em + 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.DynamicBackgrounds-Select:hover {
  background-color: var(--dbm-surface-hover);
}
.DynamicBackgrounds-Select:focus-visible {
  outline: 2px solid var(--dbm-accent);
}
.DynamicBackgrounds-Select option {
  background-color: var(--dbm-surface-raised) !important;
  color: var(--dbm-text) !important;
}
.DynamicBackgrounds-NumberInput {
  white-space: nowrap;
  padding-block: 0.25rem;
  text-align: right;
}

/* Ersatz fuer Discords Eingabefeld und Regler, falls dessen Modul fehlt. Die
   Selektoren sind mit dem Elementnamen verstaerkt, damit sie gegen
   .DynamicBackgrounds-NumberInput und Discords Klassen gewinnen. */
input.DynamicBackgrounds-fallbackInput {
  background: var(--dbm-surface);
  color: var(--dbm-text);
  border: 1px solid var(--dbm-line);
  border-radius: var(--dbm-radius-md);
  padding: 2px 8px;
  box-sizing: border-box;
}
input.DynamicBackgrounds-fallbackInput:focus-visible {
  outline: 2px solid var(--dbm-accent);
  outline-offset: -1px;
}
input.DynamicBackgrounds-fallbackInput.compact {
  width: 4rem;
  text-align: right;
  font-size: 14px;
}
input.DynamicBackgrounds-fallbackSlider {
  width: 100%;
  accent-color: var(--dbm-accent);
}

/* Aktive Schalter in der Einstellungsseite in der Akzentfarbe. */
.DynamicBackgrounds-settings .bd-switch.bd-switch-checked .bd-switch-body {
  background-color: var(--dbm-accent);
}
.DynamicBackgrounds-settings .bd-switch.bd-switch-checked .bd-switch-handle {
  fill: var(--dbm-on-accent);
}

.DynamicBackgrounds-FormNote { color: var(--dbm-text-muted); }
.DynamicBackgrounds-settingsSeparator { margin-bottom: 1rem; }
.DynamicBackgrounds-settingsFooter { display: flex; justify-content: flex-end; }

/* Kategorie-Filter der Diashow */
.DynamicBackgrounds-filterGroup { margin-bottom: 0.75rem; }
.DynamicBackgrounds-filterLabel { margin-bottom: 6px; }
.DynamicBackgrounds-filterChips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.DynamicBackgrounds-filterChip {
  padding: 5px 12px;
  border: 1px solid var(--dbm-line);
  border-radius: var(--dbm-radius-full);
  background: var(--dbm-surface-raised);
  color: var(--dbm-text-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--dbm-dur-fast) ease, color var(--dbm-dur-fast) ease, border-color var(--dbm-dur-fast) ease;
}
.DynamicBackgrounds-filterChip:hover {
  background: var(--dbm-surface-hover);
  color: var(--dbm-text);
}
.DynamicBackgrounds-filterChip.active {
  background: var(--dbm-accent);
  border-color: transparent;
  color: var(--dbm-on-accent);
}
.DynamicBackgrounds-filterChip:focus-visible {
  outline: 2px solid var(--dbm-accent);
  outline-offset: 2px;
}

/* Zeile mit Regler im Menue am Zahnrad. */
.DynamicBackgrounds-menuRow.DynamicBackgrounds-menuRow {
  display: grid;
  gap: 0.5rem;
  max-width: 16rem;
}
.DynamicBackgrounds-menuRowHead {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.DynamicBackgrounds-menuRow .DynamicBackgrounds-menuRowLabel {
  margin-right: auto;
  padding-right: 0.75rem;
  cursor: inherit;
  flex: 1 0 calc(55% - .5rem);
}

/* ==========================================================================
   BEWEGUNG
   ======================================================================== */

@keyframes fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

/* Die Karte, die von vorn nach hinten wandert.
   Eine normale transition kann nur GERADLINIG zwischen zwei Punkten
   interpolieren - damit gibt es kein Anheben und kein Herumfuehren. Deshalb
   hier echte Keyframes mit Zwischenstationen. Die Start- und Zielkoordinaten
   kommen per CSS-Variable aus dem JSX, weil sie von der Stapelgroesse
   abhaengen.

     0%   vorn oben, volle Deckkraft
     34%  angehoben, noch vorne  -> "Karte aus dem Faecher nehmen"
     66%  hinten angekommen, etwas zu tief; 82% leicht darueber (Nachfedern)
     100% unten eingereiht, blendet aus

   Ausgeblendet wird erst ab 82%, damit der Weg wirklich sichtbar ist. */
@keyframes DynamicBackgrounds-cardToBack {
  0% {
    transform: translate3d(calc(-50% + var(--bm-x-from)), var(--bm-y-from), 0) rotate(0deg) scale(1);
    opacity: 1;
    z-index: 400;
    animation-timing-function: cubic-bezier(0.16, 0.9, 0.3, 1);
  }
  34% {
    /* Angehoben und noch VORN. Der z-index bleibt bis hierher oben: faellt er
       schon bei 0%, liegt die Karte sofort hinter allen anderen, das zweite
       Bild springt frei und es sieht aus, als wuerde die Karte aus der Mitte
       hochgezogen. */
    transform: translate3d(calc(-50% + var(--bm-x-from) + 16px), calc(var(--bm-y-from) - 74px), 0) rotate(6deg) scale(1.07);
    opacity: 1;
    z-index: 400;
    animation-timing-function: cubic-bezier(0.55, 0, 0.35, 1);
  }
  36% {
    /* Erst jetzt hinter den Stapel; die Karte schwebt hier schon ueber den anderen. */
    z-index: 1;
  }
  66% {
    /* Hinten angekommen, ein Stueck zu tief: das Nachfedern beginnt */
    transform: translate3d(calc(-50% + var(--bm-x-to)), calc(var(--bm-y-to) + 9px), 0) rotate(calc(var(--bm-rot-to, 0deg) - 1.5deg)) scale(0.96);
    opacity: 1;
    animation-timing-function: ease-out;
  }
  82% {
    transform: translate3d(calc(-50% + var(--bm-x-to)), calc(var(--bm-y-to) - 4px), 0) rotate(calc(var(--bm-rot-to, 0deg) + 0.6deg)) scale(1.01);
    opacity: 1;
    animation-timing-function: ease-in-out;
  }
  100% {
    transform: translate3d(calc(-50% + var(--bm-x-to)), var(--bm-y-to), 0) rotate(var(--bm-rot-to, 0deg)) scale(1);
    /* 0 wenn die Karte aus dem Fenster faellt, 1 wenn sie sichtbar unten
       wieder einreiht (Kategorien mit hoechstens 5 Bildern). */
    opacity: var(--bm-op-end, 0);
    z-index: 1;
  }
}

/* ==========================================================================
   HINTERGRUNDEBENE DES PLUGINS (nicht Teil des Managers)
   ======================================================================== */

/* overflow: hidden beschneidet die Hintergrundebene aufs Fenster.

   Die Dauereffekte vergroessern den Container per transform: scale (1.02 bis
   1.14, siehe die bm-*-Keyframes weiter unten). Der Ueberstand ist Absicht,
   sonst tauchen beim Schwenken die Raender auf - aber ein transformiertes
   Element zaehlt mit seinem vergroesserten Kasten zur scrollbaren Flaeche
   ALLER Vorfahren. Der Container liegt absolut, also wuchs die App ueber die
   Fensterhoehe hinaus: gemessen 1626px bei 1610px Fenster.

   appMount hat overflow: hidden und laesst sich trotzdem scrollen. Die Hoehe
   pendelte im Takt der Animation, der Browser rueckte scrollTop nach, und der
   gesamte Inhalt sprang alle paar Sekunden um 16px hoch und zurueck. Sichtbar
   wurde es vor allem oben, weil die Kopfzeile dann ueber der Fensterkante lag.

   Beschnitten wird hier statt am Container selbst: Der Container IST das
   vergroesserte Element, sein eigener Kasten ragt also weiter heraus, egal was
   er mit seinen Kindern macht. Optisch aendert sich nichts, der Ueberstand war
   nie zu sehen. */
#app-mount .${constants.baseLayer.bg} {
  isolation: isolate;
  display: block;
  overflow: hidden;
}
.DynamicBackgrounds-bgContainer {
  position: absolute;
  inset: 0;
  z-index: -1;
  isolation: isolate;
}
/* Filter und Weichzeichnung haengen an data-Attributen, statt immer zu gelten.

   Vorher standen sie fest in der Regel und griffen auch dann, wenn alle Werte
   neutral waren - grayscale(0%) contrast(100%) saturate(100%) und blur(0px)
   bewirken nichts, kosten aber trotzdem: Der Browser legt fuer jeden Filter
   eine eigene Compositing-Ebene an und liest bei backdrop-filter zusaetzlich
   den Hintergrund aus. Auf zwei bildschirmfuellenden Elementen ist das die
   teuerste Dauerlast im Plugin, fuer null sichtbaren Effekt.

   Die Attribute setzt setFxFlags(), sobald sich eine Einstellung aendert. */
.DynamicBackgrounds-bgContainer::after {
  content: '';
  position: absolute;
  inset: 0;
}
.DynamicBackgrounds-bgContainer[data-blur]::after {
  backdrop-filter: blur(var(--BgManager-blur, 0px));
}
.DynamicBackgrounds-bg {
  position: absolute;
  inset: 0;
  opacity: 0;
  /* Bewusst OHNE background-attachment: fixed.

     fixed nimmt den Hintergrund von der Auslagerung auf die Grafikkarte aus und
     erzwingt bei jedem Scrollvorgang ein Neuzeichnen der gesamten Flaeche - hier
     rund zwei Millionen Pixel, bei jeder Bewegung in Kanalliste, DM-Liste oder
     Chat. Das war die mit Abstand groesste Bremse im Plugin.

     Gebraucht wird es ohnehin nicht: Das Element liegt absolut und formatfuellend,
     es scrollt gar nicht mit. Und sobald ein Dauereffekt laeuft, macht dessen
     transform den Container zum Bezugsrahmen, womit fixed sich ohnehin wie
     scroll verhaelt. */
  background: calc(50% - var(--BgManager-position-x, 0%)) calc(50% - var(--BgManager-position-y, 0%)) / cover no-repeat;
  transition: var(--BgManager-transition-duration, 0ms) ease-out;
  transition-property: opacity, transform, filter;
  transform: scale(1) translateX(0);
}
.DynamicBackgrounds-bgContainer[data-fx] .DynamicBackgrounds-bg {
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%));
}

/* mix-blend-mode zwingt beide Ebenen in eigene Layer und wird nur waehrend
   eines Bildwechsels gebraucht - dort sorgt es dafuer, dass die Ueberblendung
   nicht durchhaengt. Im Ruhezustand liegt ohnehin nur eine Ebene sichtbar
   uebereinander, dann ist es reine Last. */
.DynamicBackgrounds-bgContainer[data-fading] .DynamicBackgrounds-bg {
  mix-blend-mode: plus-lighter;
}

/* Die inaktive Ebene wird ausser waehrend eines Wechsels gar nicht gebraucht.
   Bei opacity: 0 zeichnet der Browser sie zwar nicht, haelt aber Ebene und
   Filter vor. visibility nimmt sie vollstaendig aus dem Rendering. */
.DynamicBackgrounds-bgContainer:not([data-fading]) .DynamicBackgrounds-bg:not(.active) {
  visibility: hidden;
}
.DynamicBackgrounds-bg.active {
  opacity: 1;
}
/* ============================================================================
   ÜBERGÄNGE  (data-transition, laufen EINMAL beim Bildwechsel)
   ----------------------------------------------------------------------------
   Alle nutzen --BgManager-transition-duration, respektieren also die
   eingestellte Dauer. Sie liegen auf .DynamicBackgrounds-bg, den beiden
   Bildebenen. Dauereffekte liegen dagegen auf dem Container - so kommen sich
   die beiden transform-Ketten nicht in die Quere.
   ========================================================================= */

.DynamicBackgrounds-bgContainer[data-transition="fade"] .DynamicBackgrounds-bg {
  transition-property: opacity;
}

.DynamicBackgrounds-bgContainer[data-transition="slide"] .DynamicBackgrounds-bg {
  transform: translateX(-100%);
}
.DynamicBackgrounds-bgContainer[data-transition="slide"] .DynamicBackgrounds-bg.active {
  transform: translateX(0);
}

.DynamicBackgrounds-bgContainer[data-transition="slideup"] .DynamicBackgrounds-bg {
  transform: translateY(100%);
}
.DynamicBackgrounds-bgContainer[data-transition="slideup"] .DynamicBackgrounds-bg.active {
  transform: translateY(0);
}

.DynamicBackgrounds-bgContainer[data-transition="zoom"] .DynamicBackgrounds-bg {
  transform: scale(1.25);
}
.DynamicBackgrounds-bgContainer[data-transition="zoom"] .DynamicBackgrounds-bg.active {
  transform: scale(1);
}

.DynamicBackgrounds-bgContainer[data-transition="zoomout"] .DynamicBackgrounds-bg {
  transform: scale(0.75);
}
.DynamicBackgrounds-bgContainer[data-transition="zoomout"] .DynamicBackgrounds-bg.active {
  transform: scale(1);
}

/* Die Filter-Kette wird komplett neu geschrieben, weil filter keine einzelnen
   Funktionen ueberschreiben kann. Die Regler-Variablen muessen deshalb mit. */
.DynamicBackgrounds-bgContainer[data-transition="blur"] .DynamicBackgrounds-bg {
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%)) blur(24px);
}
.DynamicBackgrounds-bgContainer[data-transition="blur"] .DynamicBackgrounds-bg.active {
  filter: grayscale(var(--BgManager-grayscale, 0%)) contrast(var(--BgManager-contrast, 100%)) saturate(var(--BgManager-saturation, 100%)) blur(0px);
}

/* Drehen plus Zoom. Ein echter Wuerfel braeuchte zwei Flaechen mit
   preserve-3d, es gibt aber nur eine Ebene. */
.DynamicBackgrounds-bgContainer[data-transition="spin"] .DynamicBackgrounds-bg {
  transform: rotate(-14deg) scale(1.4);
}
.DynamicBackgrounds-bgContainer[data-transition="spin"] .DynamicBackgrounds-bg.active {
  transform: rotate(0deg) scale(1);
}

/* Oeffnet aus der Mitte. transition-property muss opacity mitfuehren, sonst
   verschwindet das alte Bild schlagartig. */
.DynamicBackgrounds-bgContainer[data-transition="curtain"] .DynamicBackgrounds-bg {
  clip-path: inset(0 50% 0 50%);
  transition-property: opacity, clip-path;
}
.DynamicBackgrounds-bgContainer[data-transition="curtain"] .DynamicBackgrounds-bg.active {
  clip-path: inset(0 0 0 0);
}

/* clip-path statt Maske: exakt, und nutzt die eingestellte Dauer. */
.DynamicBackgrounds-bgContainer[data-transition="wipe"] .DynamicBackgrounds-bg {
  clip-path: inset(0 100% 0 0);
  transition-property: opacity, clip-path;
}
.DynamicBackgrounds-bgContainer[data-transition="wipe"] .DynamicBackgrounds-bg.active {
  clip-path: inset(0 0 0 0);
}

/* Neu: Blende, wie bei einer Kamera. */
.DynamicBackgrounds-bgContainer[data-transition="iris"] .DynamicBackgrounds-bg {
  clip-path: circle(0% at 50% 50%);
  transition-property: opacity, clip-path;
}
.DynamicBackgrounds-bgContainer[data-transition="iris"] .DynamicBackgrounds-bg.active {
  clip-path: circle(80% at 50% 50%);
}


/* ============================================================================
   DAUEREFFEKTE  (data-ambient, laufen DURCHGEHEND auf dem aktuellen Bild)
   ----------------------------------------------------------------------------
   Bewusst auf dem Container statt auf den Bildebenen: sonst wuerde ihr
   transform mit dem des Uebergangs kollidieren. So laesst sich jeder
   Dauereffekt frei mit jedem Uebergang kombinieren.
   ========================================================================= */

/* TEMPO: --BgManager-ambient-factor ist ein Multiplikator auf die Dauer.
   Er wird aus dem Regler berechnet: Faktor = 100 / Tempo.
   Also 100% = Grunddauer, 200% = doppelt so schnell, 50% = halb so schnell.
   calc() darf <time> mit einer Zahl multiplizieren - so wirkt ein einziger
   Regler auf alle Dauereffekte, ohne dass jeder eigene Werte braucht. */
.DynamicBackgrounds-bgContainer[data-ambient="kenburns"] {
  animation: bm-kenburns calc(40s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-kenburns {
  0%   { transform: scale(1.06) translate3d(0, 0, 0); }
  50%  { transform: scale(1.14) translate3d(-2.5%, -1.8%, 0); }
  100% { transform: scale(1.06) translate3d(0, 0, 0); }
}

/* transform statt background-position: laesst die X/Y-Regler in Ruhe und
   ist deutlich guenstiger. */
.DynamicBackgrounds-bgContainer[data-ambient="drift"] {
  animation: bm-drift calc(26s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-drift {
  0%   { transform: scale(1.05) translate3d(-1.2%, 0, 0); }
  50%  { transform: scale(1.05) translate3d(1.2%, -0.8%, 0); }
  100% { transform: scale(1.05) translate3d(-1.2%, 0, 0); }
}

.DynamicBackgrounds-bgContainer[data-ambient="pulse"] {
  animation: bm-pulse calc(14s * var(--BgManager-ambient-factor, 1)) ease-in-out infinite;
}
@keyframes bm-pulse {
  0%, 100% { transform: scale(1.02); filter: brightness(1); }
  50%      { transform: scale(1.05); filter: brightness(1.08); }
}

/* Gelegentlicher Ruck, kein Dauerzucken. */
.DynamicBackgrounds-bgContainer[data-ambient="glitch"] {
  animation: bm-glitch calc(6s * var(--BgManager-ambient-factor, 1)) steps(1) infinite;
}
/* Die Keyframes fuer bm-glitch stehen NICHT hier, sondern werden von
   updateGlitchKeyframes() erzeugt und als eigenes <style> eingehaengt.
   Grund: Keyframe-Marken sind Prozentwerte, also Anteile der Gesamtdauer.
   Wird der Abstand zwischen zwei Glitches kuerzer, schrumpft damit auch der
   Ausbruch selbst - er wird also schneller statt nur haeufiger. Genau das
   soll nicht passieren. CSS kann Prozentwerte nicht aus einer Variablen
   rechnen, deshalb macht es JavaScript. */

/* Koernung und Scanlines liegen auf ::before. ::after ist schon vom
   Hintergrund-Blur belegt. z-index hebt sie ueber die Bildebenen. */
.DynamicBackgrounds-bgContainer[data-ambient="grain"]::before,
.DynamicBackgrounds-bgContainer[data-ambient="scanlines"]::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

/* Deckkraft bewusst hoch genug, um wahrgenommen zu werden. */
.DynamicBackgrounds-bgContainer[data-ambient="grain"]::before {
  background-image:
    radial-gradient(rgba(255,255,255,0.55) 0.5px, transparent 0.6px),
    radial-gradient(rgba(0,0,0,0.45) 0.5px, transparent 0.6px);
  background-size: 3px 3px, 4px 4px;
  background-position: 0 0, 1px 2px;
  opacity: 0.16;
  mix-blend-mode: overlay;
  animation: bm-grain calc(0.7s * var(--BgManager-ambient-factor, 1)) steps(4) infinite;
}
@keyframes bm-grain {
  0%   { background-position: 0 0, 1px 2px; }
  25%  { background-position: 1px 2px, 2px 0; }
  50%  { background-position: 2px 1px, 0 1px; }
  75%  { background-position: 0 2px, 2px 2px; }
  100% { background-position: 0 0, 1px 2px; }
}

.DynamicBackgrounds-bgContainer[data-ambient="scanlines"]::before {
  background-image: repeating-linear-gradient(
    to bottom,
    rgba(0,0,0,0.22) 0 1px,
    transparent 1px 3px
  );
  opacity: 0.5;
  animation: bm-scanroll calc(8s * var(--BgManager-ambient-factor, 1)) linear infinite;
}
@keyframes bm-scanroll {
  0%   { background-position-y: 0; }
  100% { background-position-y: 3px; }
}

/* Wer Bewegung nicht mag, bekommt die Dauereffekte ohne Animation. */
@media (prefers-reduced-motion: reduce) {
  .DynamicBackgrounds-bgContainer[data-ambient] { animation: none !important; }
  .DynamicBackgrounds-bgContainer[data-ambient]::before { animation: none !important; }
}
`);
  }

  /**
   * Adds a suffix to a number
   * @param {number} num The number to append a suffix to
   * @returns {string}
   */
  function formatNumber(num) {
    const units = [
      { value: 1099511627776, symbol: " TiB" },
      { value: 1073741824, symbol: " GiB" },
      { value: 1048576, symbol: " MiB" },
      { value: 1024, symbol: " KiB" },
      { value: 1, symbol: " B" },
    ];
    for (const unit of units) {
      if (num >= unit.value) {
        return (num / unit.value).toFixed(1).replace(/\.0$/, '') + unit.symbol;
      }
    }
    return num.toString();
  }

  /**
   * Accessing the database and either sets the selected image as a background, or calls the callback with all items.
   * @param {undefined | (storedItems: ImageItem[]) => void} callback Callback when the items have been loaded from the database
   */
  async function setImageFromIDB(callback) {
    let db;
    return openDB('images')
      .then(database => {
        db = database;
        return getAllItems(db, 'images');
      })
      .then(storedItems => {
        callback(storedItems);
        saveItems(db, 'images', storedItems, storedItems);
      })
      .catch(err => {
        console.error('Error opening database:', err);
      }).finally(() => {
        db?.close();
      });
  }

  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false };
    }

    static getDerivedStateFromError(error) {
      return { hasError: true };
    }

    componentDidCatch(error, info) {
      console.error(error, info);
    }

    render() {
      return this.state.hasError ? jsx('div', { style: { color: '#f03' } }, 'Component Error') : this.props.children;
    }
  }

  /**
   * Returns the first element that is a ancestor of node that matches selectors.
   * @param {HTMLElement} node The HTMLelement to start the search from.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} query A string containing one or more CSS selectors to match against.
   * @returns {HTMLElementTagNameMap[K] | null} The first parent node that matches the specified group of selectors, or null if no matches are found.
   */
  function reverseQuerySelector(node, query) {
    while (node !== null && node !== document) {
      if (node.matches(query)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Force rerenders a given element, or the first found element that matches the given selector.
   * @param {HTMLElement | string} element An HTMLElement or Selector
   */
  function forceRerenderElement(element) {
    // taken and refactored from Zerthox - https://github.com/Zerthox/BetterDiscord-Plugins/blob/8ae5b44c2fc29753336cc67f31b6b99ead5608d5/packages/dium/src/utils/react.ts#L189-L208
    const queryFiber = (fiber, callback) => {
      let count = 50, parent = fiber;

      do {
        if (callback(parent)) {
          return parent;
        }
        parent = parent.return;
      } while (parent && --count);

      return null;
    };

    const forceFullRerender = fiber => new Promise(resolve => {
      const owner = queryFiber(fiber, node => node?.stateNode instanceof React.Component);
      if (owner) {
        owner.stateNode.forceUpdate(() => resolve(true));
      } else {
        resolve(false);
      }
    });
    const node = element instanceof HTMLElement ? element : document.querySelector(element);
    node ? forceFullRerender(BdApi.ReactUtils.getInternalInstance(node)) : console.warn('%c[DynamicBackgrounds] %cCould not rerender element', "color:#DBDCA6;font-weight:bold", "");
  }

  /** Returns the mime type of the image @param {Uint8Array} buffer The UInt8Array buffer */
  function getImageType(buffer) {
    const mimeTypes = [
      { mime: 'image/png', pattern: [0x89, 0x50, 0x4E, 0x47] },
      { mime: 'image/jpeg', pattern: [0xFF, 0xD8, 0xFF] },
      { mime: 'image/bmp', pattern: [0x42, 0x4D] },
      { mime: 'image/gif', pattern: [0x47, 0x49, 0x46, 0x38] },
      { mime: 'image/avif', pattern: [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] },
      { mime: 'image/webp', pattern: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
      { mime: 'image/svg+xml', pattern: [0x3C, 0x73, 0x76, 0x67] },
      { mime: 'image/x-icon', pattern: [0x00, 0x00, 0x01, 0x00] },
    ];
    for (const { mime, pattern } of mimeTypes)
      if (pattern.every((e, i) => e === null || e === buffer[i]))
        return mime;
    return '';
  }

  /**
   * Optimize a newly uploaded image by re-encoding it to WebP at the same resolution.
   * Skips animated GIFs, SVG and ICO. Returns the new Blob/File (keeps name if possible).
   * @param {Blob} blob
   * @param {string} [filename]
   * @returns {Promise<Blob|File>}
   */
  /**
   * Erzeugt die verkleinerte Fassung fuer die Rasteransicht.
   * Gibt null zurueck, wenn sich das nicht lohnt oder nicht geht - dann zeigt
   * ensureThumbURL weiterhin das Original.
   * @param {Blob} blob
   * @returns {Promise<Blob|null>}
   */
  async function makeThumb(blob) {
    try {
      if (!blob || !blob.type || !blob.type.startsWith('image/')) return null;
      // SVG skaliert von selbst, ICO ist ohnehin winzig.
      if (blob.type === 'image/svg+xml' || blob.type === 'image/x-icon') return null;

      const bitmap = await createImageBitmap(blob);
      if (bitmap.width <= THUMB_WIDTH) { bitmap.close?.(); return null; }

      const width = THUMB_WIDTH;
      const height = Math.max(1, Math.round(bitmap.height * (THUMB_WIDTH / bitmap.width)));
      const canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(width, height)
        : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();

      // 0.82 statt der 0.995 des Originals: Auf 480px sieht man den
      // Unterschied nicht, die Datei wird aber ein Vielfaches kleiner.
      if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      if (canvas.toBlob) return await new Promise(res => canvas.toBlob(res, 'image/webp', 0.82));
      return null;
    } catch (e) {
      console.warn('[DynamicBackgrounds] Thumbnail creation failed:', e);
      return null;
    }
  }

  /* Rechnet Vorschauen fuer alles nach, was vor 3.8.0 hochgeladen wurde.
     Laeuft einmal im Hintergrund, danach steht .thumb in der Datenbank.

     Bewusst NACHEINANDER und mit Rueckgabe an die Ereignisschleife zwischen den
     Bildern: alle auf einmal zu dekodieren waere genau der Speicherberg, den
     das hier abtragen soll. */
  let thumbBackfillLaeuft = false;
  async function backfillThumbs(items, onDone) {
    if (thumbBackfillLaeuft) return;
    const fehlend = (items || []).filter(e => e?.image instanceof Blob && !(e.thumb instanceof Blob));
    if (!fehlend.length) return;

    thumbBackfillLaeuft = true;
    const fertig = new Map();
    let db;
    try {
      for (const item of fehlend) {
        const thumb = await makeThumb(item.image);
        if (thumb) { item.thumb = thumb; fertig.set(item.id, thumb); }
        await new Promise(res => setTimeout(res, 16));
      }
      if (!fertig.size) return;

      /* Frisch aus der Datenbank lesen und nur .thumb ergaenzen. Die Objekte im
         React-Zustand tragen fluechtige Felder wie _thumbObjectURL mit sich -
         die haben in der Datenbank nichts verloren. */
      db = await openDB('images');
      const gespeichert = await getAllItems(db, 'images');
      gespeichert.forEach(e => { const t = fertig.get(e.id); if (t) e.thumb = t; });
      await saveItems(db, 'images', gespeichert, gespeichert);

      console.log('%c[DynamicBackgrounds] %cThumbnails generated for ' + fertig.size + ' image(s).', "color:#DBDCA6;font-weight:bold", "");
      onDone?.();
    } catch (e) {
      console.warn('[DynamicBackgrounds] Thumbnail backfill failed:', e);
    } finally {
      db?.close();
      thumbBackfillLaeuft = false;
    }
  }

  /* AKZENTFARBEN ----------------------------------------------------------

     Aus dem laufenden Hintergrundbild werden zwei Farben gerechnet und als
     --db-accent-1 und --db-accent-2 veroeffentlicht. Themes koennen sie lesen,
     das Plugin selbst benutzt sie nicht. Die Idee stammt aus dem Ursprungs-
     plugin, das eine Akzentfarbe per k-means ermittelt.

     Hier steht bewusst KEIN k-means. Ein Histogramm ueber den Farbton reicht
     fuer zwei Farben voellig aus, laeuft in einem Durchgang und hat keine
     Startwerte, die zufaellig schlecht liegen koennen. k-means waere mehr Code
     fuer ein Ergebnis, das man nicht unterscheiden kann.

     Gerechnet wird auf 64 Pixel Breite. Das genuegt fuer Farbanteile, kostet
     aber nichts: Ein Bildwechsel dekodiert dafuer rund 4000 Pixel statt vier
     Millionen. */
  let accentToken = 0;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
      h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const zwei = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + zwei(r) + zwei(g) + zwei(b);
  }

  /**
   * Zwei kraeftige Farben aus einem Bild.
   * @param {Blob} blob
   * @returns {Promise<[string, string]|null>}
   */
  async function extractAccents(blob) {
    const bitmap = await createImageBitmap(blob, { resizeWidth: 64, resizeQuality: 'low' });
    const w = bitmap.width, h = bitmap.height;
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const { data } = ctx.getImageData(0, 0, w, h);

    /* 24 Faecher zu je 15 Grad. Feiner aufzuteilen bringt nichts, weil
       benachbarte Farbtoene ohnehin als dieselbe Farbe wahrgenommen werden. */
    const FAECHER = 24;
    const punkte = new Float64Array(FAECHER);
    const summeS = new Float64Array(FAECHER);
    const summeL = new Float64Array(FAECHER);
    const anzahl = new Float64Array(FAECHER);

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const [hue, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      // Fast-Schwarz, Fast-Weiss und Graustufen tragen keine Farbe bei.
      if (l < 0.12 || l > 0.92 || s < 0.12) continue;
      const f = Math.min(FAECHER - 1, Math.floor(hue / (360 / FAECHER)));
      /* Nach Saettigung gewichtet, nicht nur gezaehlt: Eine grosse stumpfe
         Flaeche soll eine kleine leuchtende nicht verdraengen. */
      punkte[f] += 0.5 + s;
      summeS[f] += s; summeL[f] += l; anzahl[f]++;
    }

    let erste = -1;
    for (let f = 0; f < FAECHER; f++) if (erste < 0 || punkte[f] > punkte[erste]) erste = f;
    if (erste < 0 || punkte[erste] === 0) return null;

    /* Die zweite Farbe braucht Abstand, sonst bekommt man zweimal dasselbe und
       der Verlauf sieht einfarbig aus. Findet sich nichts, wird gedreht. */
    let zweite = -1;
    for (let f = 0; f < FAECHER; f++) {
      if (punkte[f] === 0) continue;
      const abstand = Math.abs(f - erste);
      if (Math.min(abstand, FAECHER - abstand) < 4) continue;
      if (zweite < 0 || punkte[f] > punkte[zweite]) zweite = f;
    }

    const ausFach = f => {
      const hue = (f + 0.5) * (360 / FAECHER);
      /* Angehoben auf einen Bereich, in dem ein Glow ueberhaupt leuchtet. Die
         Rohwerte sind oft zu dunkel oder zu blass, um als Licht zu wirken. */
      const s = Math.min(0.95, Math.max(0.55, summeS[f] / anzahl[f]));
      const l = Math.min(0.75, Math.max(0.55, summeL[f] / anzahl[f]));
      return [hue, s, l];
    };

    const [h1, s1, l1] = ausFach(erste);
    const [h2, s2, l2] = zweite >= 0 ? ausFach(zweite) : [h1 + 150, s1, l1];
    return [hslToHex(h1, s1, l1), hslToHex(h2, s2, l2)];
  }

  /* Gerechnete Farben je Bild-URL. Die Objekt-URL eines Bildes bleibt waehrend
     einer Sitzung dieselbe, ein Bild wird also hoechstens einmal ausgewertet.

     Gebraucht wird das vor allem wegen der Live-Vorschau: Beim Wandern ueber
     das Raster wechselt das Bild staendig hin und her, und beim Verlassen wird
     das vorherige zurueckgeholt. Ohne Zwischenspeicher waere das jedes Mal ein
     vollstaendiges Dekodieren fuer ein Ergebnis, das schon dastand.

     Die Obergrenze verhindert, dass die Tabelle mit widerrufenen Objekt-URLs
     vollaeuft - die Schluessel bleiben sonst liegen, auch wenn das Bild laengst
     freigegeben ist. */
  const accentCache = new Map();
  const ACCENT_CACHE_MAX = 200;
  let letzteAccentQuelle = null;

  /* Relative Helligkeit nach WCAG, fuer Farben der Form #rrggbb. */
  function luminanz(hex) {
    const [r, g, b] = [1, 3, 5].map(i => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /* Schriftfarbe fuer eine Flaeche in dieser Farbe: Weiss oder Fast-Schwarz, je
     nachdem, was das hoehere Kontrastverhaeltnis ergibt. Das Schwarz ist so
     dunkel gewaehlt, dass der schlechteste Fall (Flaeche mit mittlerer
     Helligkeit) noch ueber 4,5 zu 1 liegt; mit einem helleren Schwarz waere er
     darunter. */
  function kontrastFarbe(hex) {
    const dunkel = '#020204';
    const l = luminanz(hex);
    const gegenWeiss = 1.05 / (l + 0.05);
    const gegenDunkel = (l + 0.05) / (luminanz(dunkel) + 0.05);
    return gegenWeiss >= gegenDunkel ? '#ffffff' : dunkel;
  }

  function writeAccents(farben) {
    DOM.removeStyle('DynamicBackgrounds-accent');
    DOM.addStyle('DynamicBackgrounds-accent',
      `:root { --db-accent-1: ${farben[0]}; --db-accent-2: ${farben[1]}; --db-accent-1-contrast: ${kontrastFarbe(farben[0])}; --db-accent-2-contrast: ${kontrastFarbe(farben[1])}; }`);
  }

  /** Rechnet die Farben zum Bild und schreibt sie als CSS-Variablen. */
  function publishAccents(src) {
    if (!src || src === letzteAccentQuelle) return;
    letzteAccentQuelle = src;

    const bekannt = accentCache.get(src);
    if (bekannt) { accentToken++; writeAccents(bekannt); return; }

    const token = ++accentToken;
    (async () => {
      try {
        const blob = await (await fetch(src)).blob();
        const farben = await extractAccents(blob);
        if (!farben) return;

        if (accentCache.size >= ACCENT_CACHE_MAX) accentCache.delete(accentCache.keys().next().value);
        accentCache.set(src, farben);

        // Zwischendurch wurde schon wieder gewechselt - dieses Ergebnis ist alt.
        if (token !== accentToken) return;
        writeAccents(farben);
      } catch (e) {
        // Nicht lesbares Bild: dann bleiben die alten Farben stehen.
      }
    })();
  }

  /* DURCHSICHTIGE FLAECHEN OHNE THEME -------------------------------------

     Das Plugin malt sein Bild ganz unten in Discords Hintergrundebene. Im
     Auslieferungszustand malt Discord seine Oberflaeche aber lueckenlos deckend
     darueber: Serverleiste, Kanalliste, Chat, Mitgliederliste. Es gibt also
     keine Stelle, durch die das Bild zu sehen waere.

     Bisher konnte nur ein Theme das aufloesen. Damit war das Plugin faktisch
     kein eigenstaendiges Plugin, obwohl die README etwas anderes versprach.

     Gesetzt werden Discords eigene Hintergrund-Variablen, nicht einzelne
     Elemente. Das ist der kurze Weg und ueberlebt Klassennamen-Wechsel: Discord
     benutzt diese Variablen an hunderten Stellen selbst.

     VOLLSTAENDIG transparent, kein abdunkelnder Schleier. Ein erster Anlauf
     legte hier 45 Prozent Schwarz darueber, damit Text auf hellen Motiven
     lesbar bleibt - das war doppelt gemoppelt. Fuer genau diesen Zweck gibt es
     bereits den Regler "Dimming", und der ist die bessere Stelle: Er dunkelt
     das BILD ab statt die Oberflaeche.

     KEIN Schalter dafuer, das laeuft immer mit. Ein Hintergrundbild-Plugin, bei
     dem man erst eine Option finden muss, damit ein Hintergrundbild erscheint,
     ist kaputt und nicht einstellbar.

     ACHTUNG bei eigener Oberflaeche: Das Plugin macht damit auch SEINE EIGENEN
     Flaechen durchsichtig, wenn sie diese Variablen benutzen. Genau das ist in
     3.10.0 passiert - der Manager holte seine Farben aus
     var(--background-secondary) und wurde nach dem Einbau durchscheinend, das
     Hintergrundbild schien hindurch. Der Rueckfallwert im var() hilft nicht:
     Die Variable IST definiert, nur eben als transparent.

     Deshalb stehen im Manager feste Farben (#2b2d31, #1e1f22). Wer dort eine
     neue Flaeche baut, nimmt ebenfalls eine feste Farbe.

     KEIN @layer. Ein erster Anlauf stand in einer CSS-Ebene, mit der Idee, dass
     Themes sich dann von selbst durchsetzen: Geschichtete Regeln verlieren
     gegen ungeschichtete. Das stimmt auch - nur ist DISCORDS eigenes Stylesheet
     ebenfalls ungeschichtet. Damit hat Discord seine deckenden Farben
     zurueckgewonnen und es war wieder kein Bild zu sehen. Die Ebene hat genau
     das ausgeschaltet, was sie durchsetzen sollte.

     Also normal und ungeschichtet, aber OHNE !important. Das laesst einem Theme
     die Moeglichkeit, einzelne Werte wieder zu setzen, waehrend Discords
     Standardwerte ueberschrieben bleiben. */
  function applySurfaceTransparency() {
    DOM.removeStyle('DynamicBackgrounds-surfaces');
    DOM.addStyle('DynamicBackgrounds-surfaces', `
      :root, .theme-dark, .theme-light {
        --background-base-lowest:    transparent;
        --background-base-lower:     transparent;
        --background-base-low:       transparent;
        --background-primary:        transparent;
        --background-secondary:      transparent;
        --background-secondary-alt:  transparent;
        --background-tertiary:       transparent;
        --bg-base-tertiary:          transparent;
        --custom-channel-members-bg: transparent;
      }
    `);
  }

  async function optimizeNewUpload(blob, filename) {
    try {
      if (!blob || !blob.type || !blob.type.startsWith('image/')) return blob;
      if (blob.type === 'image/gif' || blob.type === 'image/svg+xml' || blob.type === 'image/x-icon') return blob;

      const imageBitmap = await createImageBitmap(blob);
      const width = imageBitmap.width;
      const height = imageBitmap.height;

      const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0, width, height);

      // tuned quality: higher value -> less compression (target ~1-2 MiB for large images)
      const QUALITY = 0.995;
      if (canvas.convertToBlob) {
        const out = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
        try { if (filename && typeof File !== 'undefined') return new File([out], filename.replace(/\.[^.]+$/, '.webp'), { type: out.type }); } catch (e) {}
        return out;
      } else if (canvas.toBlob) {
        const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', QUALITY));
        try { if (filename && typeof File !== 'undefined') return new File([out], filename.replace(/\.[^.]+$/, '.webp'), { type: out.type }); } catch (e) {}
        return out || blob;
      }
      return blob;
    } catch (e) {
      console.warn('[DynamicBackgrounds] optimizeNewUpload failed', e);
      return blob;
    }
  }

  // Inits and Event Listeners
  /** Manager to start and stop the slideshow. Internally handles the interval */
  const slideShowManager = function () {
    let interval, resumeTimer, lastTick = 0, pausedRemaining = null, triggeredWhileHidden = false, resumeAt = 0;

    /* Zeitpunkt des naechsten Wechsels nach aussen, nur lesend: Der Kopf des
       Managers zeichnet daraus den Fortschrittsring. Das Verhalten der Diashow
       aendert sich dadurch nicht, sie meldet nur, wann sie sich aendert. */
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* ein Zuhoerer darf die Diashow nicht stoeren */ } });
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    /** @returns {{total: number, remaining: number, running: boolean}|null} null, wenn die Diashow nicht laeuft und nichts angehalten ist */
    function getTiming() {
      const total = Math.max(constants.settings.slideshow.interval ?? 10000, 1000);
      if (interval) return { total, remaining: Math.max(0, total - (Date.now() - lastTick)), running: true };
      if (resumeTimer) return { total, remaining: Math.max(0, resumeAt - Date.now()), running: true };
      if (pausedRemaining !== null) return { total, remaining: pausedRemaining, running: false };
      return null;
    }
    function handleVisibilityChange(e) {
      e.target.visibilityState === 'visible' && (triggeredWhileHidden = false);
    }
    function start() {
      stop();
      document.addEventListener("visibilitychange", handleVisibilityChange);
      lastTick = Date.now();
      interval = setInterval(tick, Math.max(constants.settings.slideshow.interval ?? 10000, 1000));
      notify();
    }

    /* Anhalten und exakt weiterlaufen.
       setInterval kennt kein Pausieren - beim Neustart faengt die volle
       Wartezeit von vorn an. Deshalb wird beim Anhalten die bereits
       verstrichene Zeit gemerkt und beim Fortsetzen nur der REST abgewartet;
       erst danach laeuft wieder der normale Takt. So springt die Diashow nach
       einer Vorschau genau dort weiter, wo sie stand. */
    function pause() {
      if (!interval && !resumeTimer) return;
      const total = Math.max(constants.settings.slideshow.interval ?? 10000, 1000);
      pausedRemaining = Math.max(0, total - (Date.now() - lastTick));
      clearInterval(interval); interval = null;
      clearTimeout(resumeTimer); resumeTimer = null;
      notify();
    }

    function resume() {
      if (pausedRemaining === null) return;
      if (!constants.settings.slideshow.enabled) { pausedRemaining = null; return; }
      const rest = pausedRemaining;
      pausedRemaining = null;
      resumeAt = Date.now() + rest;
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        tick();
        lastTick = Date.now();
        interval = setInterval(tick, Math.max(constants.settings.slideshow.interval ?? 10000, 1000));
        notify();
      }, rest);
      notify();
    }

    async function tick() {
      lastTick = Date.now();
      notify();
      try {
        if (document.visibilityState === 'hidden') {
          if (triggeredWhileHidden) return;
          else triggeredWhileHidden = true;
        }
        try {
          const mounted = document.querySelector('.DynamicBackgrounds-gridWrapper');
          // Use cached images if available to avoid DB hits
          const storedImages = Array.isArray(constants._cachedImages) ? constants._cachedImages : [];
          let availableImages = storedImages.slice();
          if (constants._slideshowFavoritesOnly) {
            const favs = availableImages.filter(img => img.favorite);
            availableImages = favs.length ? favs : storedImages.slice();
          }
          const scf = constants._slideshowCategoryFilters;
          if (Array.isArray(scf) && scf.length) {
            availableImages = availableImages.filter(img => scf.includes((img.category || FALLBACK_CATEGORY)));
          } else if (typeof scf === 'string' && scf) {
            availableImages = availableImages.filter(img => (img.category || FALLBACK_CATEGORY) === scf);
          }
          if (availableImages.length === 0) return;

          /* Reihenfolge festlegen, BEVOR currentIndex bestimmt wird - der ist
             ein Index in genau diese Liste. Wer danach sortiert, springt an
             eine willkuerliche Stelle.

             Ohne die Sortierung lief der sequenzielle Modus in
             Hochladereihenfolge: getAll() liefert nach Schluessel, also nach
             der autoIncrement-id. Begruendung in vergleicheNachKategorie. */
          availableImages.sort(vergleicheNachKategorie);
          const currentIndex = availableImages.reduce((p, c, i) => c.selected ? i : p, null);
          if (constants.settings.slideshow.shuffle && availableImages.length > 2) {
            let x, counter = 0;
            do x = Math.floor(Math.random() * availableImages.length)
            while (x === currentIndex && counter++ < 25)
            // deselect all
            storedImages.forEach(e => {
              releaseSlideSrc(e);
              if (!mounted) {
                clearObjectURL(e);
                e.src = null;
              }
              e.selected = false;
            });
            const selectedImage = availableImages[x];
            selectedImage.selected = true;
            !mounted && setObjectURL(selectedImage, selectedImage.image);
            viewTransition.setImage(ensureSlideSrc(selectedImage));
            // persist changes
            try {
              const db = await openDB('images');
              await saveItems(db, 'images', storedImages, storedImages);
              db.close();
            } catch (err) { console.error(err) }
            console.log('%c[DynamicBackgrounds] %cBackground changed:', "color:#DBDCA6;font-weight:bold", "", new Date())
          } else if (availableImages.length) {
            const nextIndex = ((currentIndex ?? -1) + 1) % availableImages.length;
            storedImages.forEach(e => {
              releaseSlideSrc(e);
              if (!mounted) {
                clearObjectURL(e);
                e.src = null;
              }
              e.selected = false;
            });
            const selectedImage = availableImages[nextIndex];
            selectedImage.selected = true;
            !mounted && setObjectURL(selectedImage, selectedImage.image);
            viewTransition.setImage(ensureSlideSrc(selectedImage));
            try {
              const db = await openDB('images');
              await saveItems(db, 'images', storedImages, storedImages);
              db.close();
            } catch (err) { console.error(err) }
            console.log('%c[DynamicBackgrounds] %cBackground changed:', "color:#DBDCA6;font-weight:bold", "", new Date())
          }
        } catch (err) { console.error(err) }
      } finally {
        // zweite Meldung, wenn das neue Bild im Zwischenspeicher steht
        notify();
      }
    }
    function stop() {
      interval && clearInterval(interval);
      interval = null;
      resumeTimer && clearTimeout(resumeTimer);
      resumeTimer = null;
      pausedRemaining = null;
      triggeredWhileHidden = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      notify();
    }
    return { start, stop, pause, resume, getTiming, subscribe }
  }();

  /**  Controller for switching images */
  const viewTransition = function () {
    let bgContainer, activeIndex = 0, domBG = [], property, originalBackground = true, cleanupPatch, currentSrc, timer;
    function applyProperties() {
      bgContainer.style.setProperty('--BgManager-transition-duration', (constants.settings.transition.enabled ? constants.settings.transition.duration ?? 0 : 0) + 'ms');
      bgContainer.setAttribute('data-transition', constants.settings.transition.type || 'fade');
      bgContainer.setAttribute('data-ambient', constants.settings.transition.ambient || 'none');
      applyAmbientSpeed(constants.settings.transition.ambientSpeed);
      constants.settings.adjustment.xPosition && bgContainer?.style.setProperty('--BgManager-position-x', constants.settings.adjustment.xPosition + '%');
      constants.settings.adjustment.yPosition && bgContainer?.style.setProperty('--BgManager-position-y', constants.settings.adjustment.yPosition + '%');
      constants.settings.adjustment.dimming && bgContainer?.style.setProperty('--BgManager-dimming', constants.settings.adjustment.dimming);
      constants.settings.adjustment.blur && bgContainer?.style.setProperty('--BgManager-blur', constants.settings.adjustment.blur + 'px');
      constants.settings.adjustment.grayscale && bgContainer?.style.setProperty('--BgManager-grayscale', constants.settings.adjustment.grayscale + '%');
      constants.settings.adjustment.saturate !== 100 && bgContainer?.style.setProperty('--BgManager-saturation', constants.settings.adjustment.saturate + '%');
      constants.settings.adjustment.contrast !== 100 && bgContainer?.style.setProperty('--BgManager-contrast', constants.settings.adjustment.contrast + '%');
      setFxFlags();
    }

    /* Schaltet Filter und Weichzeichnung ueber data-Attribute frei - aber nur,
       wenn sie ueberhaupt etwas bewirken.

       Ohne das lag auf beiden bildschirmfuellenden Ebenen dauerhaft ein
       Filter, auch bei durchweg neutralen Werten. Ein Filter kostet immer eine
       eigene Compositing-Ebene, backdrop-filter zusaetzlich das Auslesen des
       Hintergrunds - unabhaengig davon, ob man das Ergebnis sieht. */
    function setFxFlags() {
      if (!bgContainer) return;
      /* Gelesen wird vom Element, nicht aus den Einstellungen: Beim Ziehen
         eines Reglers wird die CSS-Variable sofort gesetzt, der gespeicherte
         Wert folgt erst danach. Aus den Einstellungen gelesen haette das
         Attribut also stets einen Schritt hinterhergehinkt. */
      const s = bgContainer.style;
      const zahl = (name, standard) => {
        const v = parseFloat(s.getPropertyValue(name));
        return Number.isNaN(v) ? standard : v;
      };
      const hatFilter = zahl('--BgManager-grayscale', 0) !== 0
        || zahl('--BgManager-saturation', 100) !== 100
        || zahl('--BgManager-contrast', 100) !== 100;
      bgContainer.toggleAttribute('data-fx', hatFilter);
      bgContainer.toggleAttribute('data-blur', zahl('--BgManager-blur', 0) > 0);
    }

    /* Markiert die Zeit eines Bildwechsels.

       Nur waehrend dieser Spanne liegen beide Ebenen sichtbar uebereinander -
       dann braucht es mix-blend-mode, damit die Ueberblendung nicht
       durchhaengt, und die zweite Ebene muss dargestellt werden. Danach ist
       beides ueberfluessig und kostet nur.

       Der Aufraeumer wird bei jedem Wechsel neu gesetzt; ein rasch folgender
       zweiter Wechsel verlaengert die Spanne, statt sie vorzeitig zu beenden. */
    let fadeTimer = null;
    function markiereUeberblendung() {
      if (!bgContainer) return;
      bgContainer.toggleAttribute('data-fading', true);
      clearTimeout(fadeTimer);
      const dauer = constants.settings.transition.enabled
        ? (constants.settings.transition.duration ?? 0) : 0;
      fadeTimer = setTimeout(() => {
        bgContainer?.toggleAttribute('data-fading', false);
        fadeTimer = null;
      }, dauer + 80);   /* etwas Zuschlag, damit nichts mitten im Ausblenden abreisst */
    }
    // Use React component instead of DOM manipulation, as Discord sometimes removes those.
    function baseLayerBg() {
      const containerRef = useRef();
      const bg0Ref = useRef();
      const bg1Ref = useRef();
      useEffect(() => {
        bgContainer = containerRef.current;
        domBG = [bg0Ref.current, bg1Ref.current];
        applyProperties();
        return () => {
          bgContainer = null;
          domBG = [];
        }
      }, []);
      return jsx('div', {
        ref: containerRef,
        className: 'DynamicBackgrounds-bgContainer',
        children: [
          jsx('div', { ref: bg0Ref, className: 'DynamicBackgrounds-bg' + (activeIndex === 0 ? ' active' : ''), style: activeIndex === 0 && currentSrc ? { backgroundImage: 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + currentSrc + ')' } : null }),
          jsx('div', { ref: bg1Ref, className: 'DynamicBackgrounds-bg' + (activeIndex === 1 ? ' active' : ''), style: activeIndex === 1 && currentSrc ? { backgroundImage: 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + currentSrc + ')' } : null })
        ]
      })
    }
    function create() {
      // Target: 718813 - renderArtisanalHack()
      const mod = Webpack.getBySource("\"disable-adaptive-theme\":");
      const ThemeProviderKey = mod && Object.keys(mod).filter((key) => (source =>
        ['"disable-adaptive-theme":'].every(str => source.includes(str))
      )(mod[key].toString()))[0];
      if (!ThemeProviderKey) {
        console.error('%c[DynamicBackgrounds] %cCannot patch ThemeProvider: the internal string "disable-adaptive-theme:" was not found in Discord\'s bundle anymore. Discord likely changed this internal component; the Webpack.getBySource() filter in viewTransition.create() needs to be updated to match the current build.', "color:#DBDCA6;font-weight:bold", "");
        throw new Error("Cannot patch ThemeProvider");
      }
      cleanupPatch = Patcher.after(meta.slug, mod, ThemeProviderKey, (_, __, returnVal) => {
        if (returnVal.props?.children?.props?.className?.includes(constants.baseLayer.bg))
          returnVal.props.children.props.children = jsx(baseLayerBg)
      })
      forceRerenderElement('.' + constants.baseLayer.bg);
    }
    /* ---- Live-Vorschau ----
       Faehrt man im Raster ueber ein Bild, wird es kurz als echter Hintergrund
       gezeigt und beim Wegfahren wieder zurueckgesetzt. Bewusst OHNE die
       Auswahl zu aendern: es wird nichts gespeichert, nur angezeigt.
       previewBackup merkt sich das zuvor aktive Bild. */
    let previewBackup = null;

    /* Waehrend der Vorschau: Uebergangsdauer 0 und Diashow angehalten. Die
       Vorschau soll zeigen, wie ein Bild wirkt - nicht den Uebergang vorfuehren. */
    function previewImage(src) {
      if (!src || src === currentSrc) return;
      if (previewBackup === null) {
        previewBackup = currentSrc;
        bgContainer?.style.setProperty('--BgManager-transition-duration', '0ms');
        // pause() statt stop(): die Restlaufzeit bleibt erhalten
        try { slideShowManager.pause(); } catch (err) {}
      }
      setImage(src);
    }

    /** Uebergangsdauer und Diashow-Takt wieder so herstellen wie vor der Vorschau. */
    function restoreAfterPreview() {
      bgContainer?.style.setProperty('--BgManager-transition-duration',
        (constants.settings.transition.enabled ? constants.settings.transition.duration ?? 0 : 0) + 'ms');
      try { slideShowManager.resume(); } catch (err) {}
    }

    /** Maus verlaesst das Bild: vorheriges Bild zurueckholen. */
    function endPreview() {
      if (previewBackup === null) return;
      const restore = previewBackup;
      previewBackup = null;
      if (restore) setImage(restore);
      restoreAfterPreview();
    }

    /* Klick waehrend der Vorschau: Bild bleibt, Vorschau-Zustand endet.
       Ohne das bliebe die Diashow dauerhaft angehalten. */
    function commitPreview() {
      if (previewBackup === null) return;
      previewBackup = null;
      restoreAfterPreview();
    }

    /** @param {string} src  */
    function setImage(src) {

      currentSrc = src;
      /* Einziger Punkt, durch den jeder Bildwechsel laeuft: Diashow,
         Handauswahl, Live-Vorschau und Start. Deshalb steht es hier und nicht
         an vier Aufrufstellen. */
      publishAccents(src);
      if (domBG.length === 2) {
        document.visibilityState === 'visible' && (activeIndex ^= 1);
        domBG[activeIndex].style.backgroundImage = 'linear-gradient(rgba(0,0,0,var(--BgManager-dimming,0)), rgba(0,0,0,var(--BgManager-dimming,0))), url(' + src + ')';
        domBG[activeIndex].classList.add('active');
        domBG[activeIndex ^ 1].classList.remove('active');
        markiereUeberblendung();
      }
      if (!property || !constants.settings.overwriteCSS) return;
      if (originalBackground) {
        originalBackground = false;
        timer = setTimeout(() => {
          DOM.removeStyle('DynamicBackgrounds-background');
          DOM.addStyle('DynamicBackgrounds-background', property.map(e => `${e.selector} {${e.property}: url('${src}') !important;}`).join('\n'));
          timer = null;
        }, constants.settings.transition.duration)
      } else {
        DOM.removeStyle('DynamicBackgrounds-background');
        DOM.addStyle('DynamicBackgrounds-background', property.map(e => `${e.selector} {${e.property}: url('${src}') !important;}`).join('\n'));
      }
    }
    function removeImage() {
      domBG.forEach(e => e.classList.remove('active'));
      originalBackground = true
      DOM.removeStyle('DynamicBackgrounds-background');
    }
    function destroy() {
      cleanupPatch?.();
      constants.baseLayer?.bg && forceRerenderElement('.' + constants.baseLayer.bg);
      timer && (clearTimeout(timer), timer = null);
      originalBackground = true;
      DOM.removeStyle('DynamicBackgrounds-background');
      bgContainer = null;
      currentSrc = null;
      previewBackup = null;   // sonst haengt eine laufende Vorschau nach
      activeIndex = 0;
      domBG = [];
    }
    function setProperty(overwrite = true) {
      const themes = document.querySelectorAll('bd-head  bd-themes style');
      if (!themes?.length) return;
      const foundProperties = [];
      for (const theme of themes) {
        const sheet = [...document.styleSheets].find(sheet => sheet.ownerNode === theme);
        if (!sheet) continue;
        const cssVariables = {};

        // Iterate through the CSS rules in the stylesheet
        for (const rule of sheet.cssRules) {
          if (!rule || rule instanceof CSSImportRule || !(rule instanceof CSSStyleRule)) continue;
          for (const customProperty of rule.style) {
            if (customProperty.startsWith('--')) {
              const value = rule.style.getPropertyValue(customProperty).trim();
              if (value.startsWith('url')) {
                if (!cssVariables[customProperty])
                  cssVariables[customProperty] = { value, selectors: [] };
                cssVariables[customProperty].selectors.push(rule.selectorText || ':root');
              }
            }
          }
        }
        // auf tatsaechlichen Inhalt pruefen, nicht auf das Objekt selbst
        if (!Object.keys(cssVariables).length) continue;
        let customProperty;
        block: if (Object.keys(cssVariables).length === 1) {
          customProperty = Object.keys(cssVariables)[0];
        } else {
          for (const key of Object.keys(cssVariables)) { // prioritize background, bg, backdrop
            if (['background', 'bg', 'wallpaper', 'backdrop'].some(e => key.toLowerCase().includes(e))) {
              customProperty = key;
              break block;
            }
          }
          for (const key of Object.keys(cssVariables)) { // if no variable is found, look for images.
            if (['image', 'img'].some(e => key.toLowerCase().includes(e))) {
              customProperty = key;
              break block;
            }
          }
        }
        if (!customProperty) continue;
        foundProperties.push({ property: customProperty, selector: cssVariables[customProperty].selectors[0] });
      }
      if (!foundProperties.length) return (property = null);
      property = foundProperties;
      overwrite && setImageFromIDB(storedImages => {
        storedImages.forEach(image => {
          if (image.selected && image.src) {
            DOM.removeStyle('DynamicBackgrounds-background');
            DOM.addStyle('DynamicBackgrounds-background', property.map(e => `${e.selector} {${e.property}: url('${image.src}') !important;}`).join('\n'));
          }
        })
      });
    }
    return { create, setImage, removeImage, destroy, bgContainer: () => bgContainer, setProperty, previewImage, endPreview, commitPreview, setFxFlags }
  }();

  const themeObserver = function () {
    let nodeObserver, debounceTimer;
    function start() {
      if (nodeObserver) stop();

      // <bd-themes> fehlt, wenn das Theme in Custom CSS oder Vencord QuickCSS liegt.
      // observe(null) wuerde werfen und das Plugin ueber das catch deaktivieren.
      const target = document.querySelector('bd-head bd-themes');
      if (!target) {
        console.warn('%c[DynamicBackgrounds] %cNo <bd-themes> found - overwriteCSS is being skipped. The plugin keeps running normally and uses its own background layer.', "color:#DBDCA6;font-weight:bold", "");
        return;
      }

      // setProperty() iteriert durch alle CSS-Regeln aller Themes - deshalb entprellt.
      nodeObserver = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => viewTransition.setProperty(), 200);
      })
      nodeObserver.observe(target, { childList: true, subtree: true });
    }
    function stop() {
      DOM.removeStyle('DynamicBackgrounds-background');
      clearTimeout(debounceTimer);
      debounceTimer = null;
      nodeObserver?.disconnect();
      nodeObserver = null;
    }
    return { start, stop }
  }();

  /* --------------------------------------------------------------------------
     UPDATE-PRUEFUNG

     BetterDiscord wertet @updateUrl im Kopf dieser Datei NICHT aus - ohne
     Code hier ist der Eintrag reine Deko. Also selbst machen: beim Start die
     Fassung auf GitHub holen, @version vergleichen, und bei einer neueren
     Fassung anbieten, die Datei zu ersetzen. BetterDiscord bemerkt die
     geaenderte Datei von allein und laedt neu.

     Ueber normales fetch() laeuft das nicht: Discords CSP blockt fremde
     Hosts. BdApi.Net.fetch geht ueber den Hauptprozess daran vorbei.
     ----------------------------------------------------------------------- */

  const UPDATE_VERZOEGERUNG = 8000;   // Discord erst in Ruhe starten lassen
  let updateTimer = null;

  // Nur den Kopf durchsuchen - im Rumpf koennte '@version' als Text stehen.
  function versionAus(text) {
    return /@version\s+([0-9][0-9A-Za-z.\-+]*)/.exec(String(text).slice(0, 2000))?.[1] ?? null;
  }

  // Stellenweiser Zahlenvergleich: '3.10.0' ist neuer als '3.9.0'. Ein reiner
  // Textvergleich wuerde hier das Gegenteil behaupten.
  function istNeuer(fern, lokal) {
    const teile = v => String(v ?? '').split('.').map(n => parseInt(n, 10) || 0);
    const a = teile(fern);
    const b = teile(lokal);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  async function pruefeAufUpdates({ leise = true } = {}) {
    if (!meta.updateUrl || !meta.filename) return 0;

    let inhalt;
    try {
      // Cache-Buster: raw.githubusercontent liefert sonst minutenlang die
      // alte Fassung aus, und der Update-Check meldet nichts.
      const trenner = meta.updateUrl.includes('?') ? '&' : '?';
      const antwort = await BdApi.Net.fetch(meta.updateUrl + trenner + 't=' + Date.now(),
        { headers: { 'Cache-Control': 'no-cache' } });
      if (!antwort.ok) throw new Error('HTTP ' + antwort.status);

      inhalt = await antwort.text();

      // Wichtig: Eine falsche URL liefert eine HTML-Fehlerseite mit Status 200
      // statt einer Addon-Datei. Ohne diese Pruefung wuerde die einfach ueber
      // das laufende Plugin geschrieben und es waere kaputt.
      if (inhalt.length < 200 || !versionAus(inhalt)) {
        throw new Error('Antwort sieht nicht nach einer Addon-Datei aus');
      }
    } catch (e) {
      // Kein Netz, GitHub gerade weg, Tippfehler in der URL - kein Grund, den
      // Nutzer zu behelligen. Nur ins Log.
      console.warn('%c[DynamicBackgrounds] %cUpdate check failed:', "color:#DBDCA6;font-weight:bold", "", e.message);
      return 0;
    }

    const fern = versionAus(inhalt);
    if (!istNeuer(fern, meta.version)) {
      if (!leise) UI.showToast('Everything is up to date.', { type: 'success' });
      return 0;
    }

    UI.showNotice(meta.name + ' ' + fern + ' is available (installed: ' + meta.version + ').', {
      type: 'info',
      buttons: [{
        label: 'Update',
        // BetterDiscord reicht dem Knopf die Funktion zum Schliessen der
        // Meldung als erstes Argument herein. Zuerst schliessen, dann melden:
        // das Schreiben stoesst BetterDiscords Neuladen an, und danach muss
        // hier nichts mehr passieren. Schlaegt es fehl, bleibt die Meldung
        // absichtlich stehen - sonst waere der zweite Versuch weg.
        onClick: async (schliessen) => {
          try {
            // Bewusst die Callback-Fassung und nicht fs.promises: das fs-Modul,
            // das Discords Renderer ueber require herausgibt, hat keine
            // promises-Eigenschaft. fs.promises.writeFile scheitert dort mit
            // "Cannot read properties of undefined".
            const fs = require('fs');
            const path = require('path');
            const ziel = path.join(BdApi.Plugins.folder, meta.filename);
            await new Promise((erfuellen, ablehnen) => {
              fs.writeFile(ziel, inhalt, 'utf8', fehler => fehler ? ablehnen(fehler) : erfuellen());
            });
            schliessen?.();
            UI.showToast(meta.name + ' updated to ' + fern + '.', { type: 'success' });
          } catch (e) {
            console.error('[DynamicBackgrounds] Update failed:', e);
            UI.showToast('Update failed - see console.', { type: 'error' });
          }
        }
      }]
    });
    return 1;
  }

  return {
    start: async () => {
      // Bewusst als Erstes: scheitert der Rest, ist die Update-Pruefung erst
      // recht interessant - womoeglich behebt die neue Fassung genau das.
      updateTimer = setTimeout(() => { pruefeAufUpdates(); }, UPDATE_VERZOEGERUNG);

      try {
        !Object.keys(constants).length && console.log('%c[DynamicBackgrounds] %cInitialized', "color:#DBDCA6;font-weight:bold", "")
        const configs = Data.load(meta.slug, "settings");
        // Gespeicherte Uebergaenge umbiegen, siehe legacyTransitionMap
        if (configs?.transition) configs.transition = migrateTransition(configs.transition);
        // Auffang-Kategorie in der Liste umbenennen, Duplikate vermeiden
        if (Array.isArray(configs?.categories) && configs.categories.includes(LEGACY_FALLBACK_CATEGORY)) {
          configs.categories = [...new Set(configs.categories.map(c => c === LEGACY_FALLBACK_CATEGORY ? FALLBACK_CATEGORY : c))];
        }
        if (configs?.selectedCategory === LEGACY_FALLBACK_CATEGORY) configs.selectedCategory = FALLBACK_CATEGORY;
        if (Array.isArray(configs?.slideshow?.categoryFilters)) {
          configs.slideshow.categoryFilters = configs.slideshow.categoryFilters.map(c => c === LEGACY_FALLBACK_CATEGORY ? FALLBACK_CATEGORY : c);
        }
        if (configs?.slideshow?.categoryFilter === LEGACY_FALLBACK_CATEGORY) configs.slideshow.categoryFilter = FALLBACK_CATEGORY;
        // Migrate legacy single slideshow.categoryFilter -> slideshow.categoryFilters (array)
        if (configs?.slideshow && configs.slideshow.categoryFilter && !configs.slideshow.categoryFilters) {
          try { configs.slideshow.categoryFilters = [configs.slideshow.categoryFilter]; } catch (e) {}
        }
        // Helper: run a module lookup safely and log a clear, labeled warning if it fails,
        // instead of letting one broken Webpack filter throw and silently kill the whole start().
        function safeLookup(label, fn) {
          try {
            const result = fn();
            if (result === undefined || result === null) {
              console.warn(`%c[DynamicBackgrounds] %cModule lookup "${label}" returned nothing. Discord's internals may have changed (filter no longer matches).`, "color:#DBDCA6;font-weight:bold", "");
            }
            return result;
          } catch (e) {
            console.warn(`%c[DynamicBackgrounds] %cModule lookup "${label}" threw an error:`, "color:#DBDCA6;font-weight:bold", "", e);
            return undefined;
          }
        }

        const modules = {
          toolbarClasses: safeLookup('toolbarClasses', () => Webpack.getByKeys("iconWrapper", "toolbar")), // classes for toolbar
          messagesPopoutClasses: safeLookup('messagesPopoutClasses', () => Webpack.getByKeys("messagesPopout")), // classes for messages popout
          textStyles: safeLookup('textStyles', () => Webpack.getByKeys("defaultColor")), // classes for general text styles
          markupStyles: safeLookup('markupStyles', () => Webpack.getByKeys("markup")),
          slider: safeLookup('slider', () => Webpack.getByKeys("sliderContainer", "slider")),
          /* Discord hat "trapClicks" aus diesem Modul entfernt. Die Suche lief
             danach ins Leere, und weil ManagerComponent ohne den Klassennamen
             ausstieg, liess sich das Fenster nur noch ueber sein Symbol
             schliessen. Erst der alte Schluessel, dann der neue - so greift es
             auf beiden Staenden. */
          layerContainerClass: safeLookup('layerContainerClass', () => Webpack.getByKeys("trapClicks") || Webpack.getByKeys("layerContainer")), // classes of Discord's native layer container
          originalLink: safeLookup('originalLink', () => Webpack.getByKeys("originalLink")), // classes for image embed
          scrollbar: safeLookup('scrollbar', () => Webpack.getByKeys("thin")), // classes for scrollable content
          separator: safeLookup('separator', () => Webpack.getByKeys("scroller", "label")), // classes for separator
          baseLayer: safeLookup('baseLayer', () => Webpack.getByKeys("baseLayer", "bg")), // classes of Discord's base layer
          // Module for lazy carousel - non-essential, guarded so a miss here can't throw before the essential check runs
          lazyCarousel: safeLookup('lazyCarousel', () => {
            const mod = Webpack.getBySource(".MEDIA_VIEWER", ".OPEN_MODAL");
            return mod ? Object.values(mod)[0] : undefined;
          }),
          settings: {
            ...defaultSettings, ...configs,
            transition: { ...defaultSettings.transition, ...configs?.transition },
            slideshow: { ...defaultSettings.slideshow, ...configs?.slideshow },
            adjustment: { ...defaultSettings.adjustment, ...configs?.adjustment }
          },
          // native ui module - previously fetched via getMangled(m => m.showToast, {...}), but that
          // base-module lookup (m.showToast) no longer matches anything in current Discord builds.
          // Each component below is still findable individually, so look each one up directly instead.
          nativeUI: {
            FocusRing: safeLookup('nativeUI.FocusRing', () => Webpack.getModule(Filters.byStrings("FocusRing was given a focusTarget"), { searchExports: true })),
            FormTitle: safeLookup('nativeUI.FormTitle', () => Webpack.getModule(Filters.byStrings(".errorSeparator"), { searchExports: true })),
            MenuSliderControl: safeLookup('nativeUI.MenuSliderControl', () => Webpack.getModule(Filters.byStrings("moveGrabber"), { searchExports: true })),
            Popout: safeLookup('nativeUI.Popout', () => Webpack.getModule(Filters.byStrings("Unsupported animation config:"), { searchExports: true })),
            Spinner: safeLookup('nativeUI.Spinner', () => Webpack.getModule(Filters.byStrings(".stopAnimation]:"), { searchExports: true })),
            Tooltip: safeLookup('nativeUI.Tooltip', () => Webpack.getModule(Filters.byStrings("this.renderTooltip()]"), { searchExports: true })),
            useFocusLock: safeLookup('nativeUI.useFocusLock', () => Webpack.getModule(Filters.byStrings("disableReturnRef:"), { searchExports: true })),
          },
        }
        Object.assign(modules.nativeUI, {
          Button: safeLookup('nativeUI.Button', () => Webpack.getModule(Filters.byStrings(",submittingFinishedLabel:"), { searchExports: true })),
          TextInput: safeLookup('nativeUI.TextInput', () => Webpack.getModule(Filters.byStrings("allowOverflow", "autoFocus"), { searchExports: true })),
        })
        const requiredNativeUI = ["Popout", "Tooltip", "Spinner", "FocusRing"];
        const missingNativeUI = requiredNativeUI.filter(key => !modules.nativeUI[key]);
        if (!modules.baseLayer || missingNativeUI.length) {
          const missingList = [
            !modules.baseLayer ? 'baseLayer' : null,
            ...missingNativeUI.map(k => `nativeUI.${k}`)
          ].filter(Boolean).join(', ');
          console.error(`%c[DynamicBackgrounds] %cCannot start: missing module(s) -> ${missingList}. Discord likely changed the internal code these filters look for; the filters in the plugin need to be updated.`, "color:#DBDCA6;font-weight:bold", "");
          throw new Error("Missing essential modules: " + missingList);
        }
        Object.assign(constants, modules);
        generateCSS();
        // On startup, refresh objectURL of stored selected image and populate in-memory cache.
        {
          let db;
          await openDB('images').then(database => {
            db = database;
            return getAllItems(db, 'images');
          }).then(storedItems => {
            storedItems.forEach(e => {
              clearObjectURL(e);
              e.src = e.selected ? ensureObjectURL(e) : null;
            });

            /* Einmalige Umbenennung der Auffang-Kategorie. Der Name steht an
               jedem Bild, deshalb muessen die Datensaetze mitgezogen werden -
               sonst blieben sie in einer Gruppe zurueck, die es nicht mehr gibt. */
            const toMigrate = storedItems.filter(e => e.category === LEGACY_FALLBACK_CATEGORY);
            if (toMigrate.length) {
              toMigrate.forEach(e => { e.category = FALLBACK_CATEGORY; });
              console.log('%c[DynamicBackgrounds] %c' + toMigrate.length + ' image(s) moved from "' + LEGACY_FALLBACK_CATEGORY + '" to "' + FALLBACK_CATEGORY + '".', "color:#DBDCA6;font-weight:bold", "");
              try { saveItems(db, 'images', storedItems, storedItems); } catch (e) { console.error(e); }
            }

            try { constants._cachedImages = storedItems.map(e => ({ ...e })); } catch (e) { /* ignore */ }
          }).catch(err => console.error(err)).finally(() => db?.close());
        }
        // create image containers
        viewTransition.create();
        // set up css property using refreshed objectURL
        constants.settings.overwriteCSS && viewTransition.setProperty();
        applySurfaceTransparency();
        // finally, set the selected image, if any, as background. A bit convoluted, but order is important.
        await setImageFromIDB(storedImages => {
          const img = storedImages.find(image => image.selected);
          img && viewTransition.setImage(img.src)
        });
        // Start Slideshow if enabled
        constants.settings.slideshow.enabled && slideShowManager.start();
        constants.settings.overwriteCSS && themeObserver.start();
        addButton();
      } catch (e) {
        console.error(e);
        UI.showToast("Could not start DynamicBackgrounds", { type: 'error' });
        BdApi.Plugins.disable(meta.id);
      }
    },
    stop: stop,
    getSettingsPanel: () => jsx(ErrorBoundary, null, jsx(BuildSettings))
  }
}


