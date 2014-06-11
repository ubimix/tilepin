var _ = require('underscore');
var Styles = require('./tilepin-styles');

function StyleGenerator(options) {
    this.options = options || {};
}
_.extend(StyleGenerator.prototype, {
    setZoom : function(min, max) {
        this.options.fromZoom = min;
        this.options.toZoom = max;
        return this;
    },
    set : function(options) {
        _.extend(this.options, options);
        return this;
    },
    generate : function(listener) {
        var options = this.options;
        var fromZoom = options.fromZoom || 0;
        var toZoom = options.toZoom || 20;

        var getOpacity = Styles.linearInc(0, 1, function(zoom, opacity) {
            return {
                opacity : opacity
            }
        });
        var getWidth = Styles.expInc(2, function(zoom, f) {
            return {
                width : 1 / f
            }
        });

        var style = Styles();
        return style
        //
        .add(listener.onBegin({
            style : style,
            zoom : fromZoom,
            width : getWidth(fromZoom, fromZoom, toZoom).width,
            opacity : getOpacity(fromZoom, fromZoom, toZoom).opacity
        }))
        //
        .range(
                fromZoom,
                toZoom,
                function(zoom, fromZoom, toZoom) {
                    var options = _.extend({
                        style : style,
                        zoom : zoom,
                        fromZoom : fromZoom,
                        toZoom : toZoom
                    }, getOpacity(zoom, fromZoom, toZoom), getWidth(zoom,
                            fromZoom, toZoom));
                    var obj = {};
                    obj['[zoom>=' + zoom + ']'] = listener.getStyle(options);
                    return obj;
                })
        // 
        .add(listener.onEnd({
            style : style,
            zoom : toZoom,
            width : getWidth(toZoom, fromZoom, toZoom).width,
            opacity : getOpacity(toZoom, fromZoom, toZoom).opacity
        }));
    }

});
/* ------------ */
StyleGenerator.Listener = function(options) {
    _.extend(this, options);
}
_.extend(StyleGenerator.Listener.prototype, {
    onBegin : function(options) {
    },
    getStyle : function(options) {
    },
    onEnd : function(options) {
    },
    setWidth : function(value) {
        this.width = value;
        return this;
    },
    setOpacity : function(from, to) {
        this.fromOpacity = from || 0;
        this.toOpacity = to || 1;
        return this;
    },
    _getOpacity : function(options) {
        var from = this.fromOpacity || 0;
        var to = this.toOpacity || 1;
        return from + (to - from) * options.opacity;
    },
});

/* ------------ */
StyleGenerator.Markers = function(options) {
    _.extend(this, options);
};
_.extend(StyleGenerator.Markers.prototype, StyleGenerator.Listener.prototype);
_.extend(StyleGenerator.Markers.prototype, {
    onBegin : function(options) {
        return {
            'marker-fill' : this.color,
            'marker-line-color' : this.lineColor || this.color,
            'marker-line-width' : (this.lineWidth || 1) * options.width,
            'marker-line-opacity' : this._getOpacity(options),
            'marker-width' : this.width * options.width,
            'marker-opacity' : this._getOpacity(options),
            'marker-placement' : 'point',
            'marker-type' : 'ellipse',
            'marker-allow-overlap' : 'true',
        };
    },
    getStyle : function(options) {
        return {
            'marker-opacity' : this._getOpacity(options),
            'marker-width' : this.width * options.width,
            'marker-line-width' : (this.lineWidth || 1) * options.width,
        }
    },
    setLineWidth : function(value) {
        this.lineWidth = value;
        return this;
    },

});

/* ------------ */
StyleGenerator.Lines = function(options) {
    _.extend(this, options);
    if (this.width === undefined) {
        this.width = 1;
    }
}
_.extend(StyleGenerator.Lines.prototype, StyleGenerator.Listener.prototype);
_.extend(StyleGenerator.Lines.prototype, {
    onBegin : function(options) {
        return {
            'line-join' : 'round',
            'line-cap' : 'round',
            'line-color' : this.color,
            'line-width' : this.width * options.width,
            'line-opacity' : this._getOpacity(options),
        };
    },
    getStyle : function(options) {
        return {
            'line-width' : this.width * options.width,
            'line-opacity' : this._getOpacity(options),
        }
    }
});
module.exports = StyleGenerator;
