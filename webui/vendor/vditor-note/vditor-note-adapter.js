(function() {
    'use strict';

    var STOP_EVENTS = [
        'keydown',
        'keypress',
        'keyup',
        'beforeinput',
        'input',
        'paste',
        'cut',
        'copy',
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'wheel',
        'contextmenu'
    ];

    var LANG_MAP = {
        'zh-cn': 'zh_CN',
        'zh_cn': 'zh_CN',
        'zh': 'zh_CN',
        'zh-tw': 'zh_TW',
        'zh_tw': 'zh_TW',
        'en': 'en_US',
        'en-us': 'en_US',
        'en_us': 'en_US',
        'de': 'de_DE',
        'de-de': 'de_DE',
        'es': 'es_ES',
        'es-es': 'es_ES',
        'fr': 'fr_FR',
        'fr-fr': 'fr_FR',
        'ja': 'ja_JP',
        'ja-jp': 'ja_JP',
        'ko': 'ko_KR',
        'ko-kr': 'ko_KR',
        'pt': 'pt_BR',
        'pt-br': 'pt_BR',
        'ru': 'ru_RU',
        'ru-ru': 'ru_RU'
    };

    function stopPropagation(event) {
        event.stopPropagation();
    }

    function getCdn() {
        return window.KM_VDITOR_CDN || 'vendor/vditor-note';
    }

    function normalizeLang(lang) {
        var value = (lang || '').toLowerCase();
        return LANG_MAP[value] || 'en_US';
    }

    function createVditorNoteEditor(host, options) {
        if (!host) {
            throw new Error('createVditorNoteEditor requires a host element');
        }
        if (!window.Vditor) {
            throw new Error('Vditor is not loaded');
        }

        options = options || {};
        var cdn = getCdn();
        var value = options.markdown || '';
        var readOnly = !!options.readOnly;
        var onChange = typeof options.onChange === 'function' ? options.onChange : null;
        var editor = null;
        var ready = false;
        var destroyed = false;
        var pendingFocus = false;
        var pendingMarkdown = null;
        var applyingValue = false;

        function updateHostState() {
            host.classList.toggle('vditor-note-readonly', readOnly);
        }

        function applyReadOnly() {
            if (destroyed) return;
            updateHostState();
            if (!ready || !editor) return;
            if (readOnly) {
                editor.disabled();
            } else {
                editor.enable();
            }
        }

        function applyMarkdown(markdown) {
            if (destroyed) return;
            value = markdown || '';
            if (!ready || !editor) {
                pendingMarkdown = value;
                return;
            }

            applyingValue = true;
            try {
                editor.setValue(value, true);
            } finally {
                setTimeout(function() {
                    applyingValue = false;
                });
            }
        }

        function handleChange(markdown) {
            value = markdown || '';
            if (!applyingValue && !readOnly && onChange) {
                onChange(value);
            }
        }

        function handleReady() {
            if (destroyed) return;
            ready = true;
            if (pendingMarkdown !== null) {
                applyMarkdown(pendingMarkdown);
                pendingMarkdown = null;
            }
            applyReadOnly();
            if (pendingFocus) {
                pendingFocus = false;
                editor.focus();
            }
        }

        STOP_EVENTS.forEach(function(eventName) {
            host.addEventListener(eventName, stopPropagation, false);
        });

        updateHostState();
        editor = new window.Vditor(host, {
            value: value,
            cdn: cdn,
            _lutePath: cdn + '/dist/js/lute/lute.min.js',
            lang: normalizeLang(window.lang || navigator.language),
            mode: 'wysiwyg',
            theme: 'classic',
            icon: null,
            height: '100%',
            width: '100%',
            minHeight: 120,
            toolbar: [],
            toolbarConfig: {
                hide: true,
                pin: false
            },
            resize: {
                enable: false
            },
            cache: {
                enable: false
            },
            counter: {
                enable: false
            },
            outline: {
                enable: false,
                position: 'left'
            },
            hint: {
                emojiPath: cdn + '/dist/images/emoji'
            },
            link: {
                isOpen: false
            },
            preview: {
                delay: 1000,
                mode: 'editor',
                hljs: {
                    enable: false,
                    style: 'github'
                },
                markdown: {
                    codeBlockPreview: false,
                    footnotes: true,
                    gfmAutoLink: true,
                    mathBlockPreview: false,
                    sanitize: true
                },
                math: {
                    inlineDigit: false
                },
                theme: {
                    current: 'light',
                    path: cdn + '/dist/css/content-theme'
                }
            },
            input: handleChange,
            keydown: stopPropagation,
            after: handleReady
        });

        return {
            setMarkdown: applyMarkdown,
            getMarkdown: function() {
                if (ready && editor) {
                    try {
                        value = editor.getValue() || '';
                    } catch (err) {
                        value = value || '';
                    }
                }
                return value || '';
            },
            focus: function() {
                if (readOnly) return;
                if (ready && editor) {
                    editor.focus();
                } else {
                    pendingFocus = true;
                }
            },
            setReadOnly: function(nextReadOnly) {
                readOnly = !!nextReadOnly;
                applyReadOnly();
            },
            setOnChange: function(nextOnChange) {
                onChange = typeof nextOnChange === 'function' ? nextOnChange : null;
            },
            destroy: function() {
                if (destroyed) return;
                destroyed = true;
                STOP_EVENTS.forEach(function(eventName) {
                    host.removeEventListener(eventName, stopPropagation, false);
                });
                if (ready && editor && typeof editor.destroy === 'function') {
                    try {
                        editor.destroy();
                    } catch (err) {
                        host.textContent = '';
                    }
                } else {
                    host.textContent = '';
                }
                editor = null;
                onChange = null;
                pendingMarkdown = null;
            }
        };
    }

    window.VditorNote = Object.assign(window.VditorNote || {}, {
        createVditorNoteEditor: createVditorNoteEditor
    });
})();
