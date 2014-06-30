var Tilepin = require('../lib/Tilepin.Carto.Styles.js');
require('../lib/Tilepin.P');
var expect = require('expect.js');
var _ = require('underscore');

describe('Tilepin.Carto.Styles', function() {
    it('should be able to load and serialize styles', function() {
        var styles = Tilepin.Carto.Styles({
            'marker-width' : 1,
            '[zoom>8]' : {
                'marker-width' : 3
            }
        }).add({
            'marker-fill' : 'maroon',
            '[zoom>8]' : {
                'marker-fill' : 'red'
            }
        });
        expect(styles.get()).to.eql({
            'marker-width' : 1,
            '[zoom>8]' : {
                'marker-width' : 3,
                'marker-fill' : 'red'
            },
            'marker-fill' : 'maroon'
        });
        var expected = '' //
                + 'marker-width: 1;\n' //
                + '[zoom>8] {\n'//
                + '  marker-width: 3;\n' //
                + '  marker-fill: red;\n'//
                + '}\n' //
                + 'marker-fill: maroon;\n' //
                + '';
        expect(styles.serialize()).to.eql(expected);
    });
    it('should be able to generate styles', function() {
        var styles = new Tilepin.Carto.Styles({
            'marker-fill' : 'red'
        });
        styles.range(0, 10, Tilepin.Carto.Styles.linear(0, 11, function(zoom,
            width) {
            var obj = {};
            obj['[zoom>=' + zoom + ']'] = width.toFixed(2) + 'px';
            return obj;
        }));
        expect(styles.get()).to.eql({
            'marker-fill' : 'red',
            '[zoom>=0]' : '0.00px',
            '[zoom>=1]' : '1.10px',
            '[zoom>=2]' : '2.20px',
            '[zoom>=3]' : '3.30px',
            '[zoom>=4]' : '4.40px',
            '[zoom>=5]' : '5.50px',
            '[zoom>=6]' : '6.60px',
            '[zoom>=7]' : '7.70px',
            '[zoom>=8]' : '8.80px',
            '[zoom>=9]' : '9.90px',
            '[zoom>=10]' : '11.00px'
        })
    });
})
