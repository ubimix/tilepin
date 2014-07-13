var Tilepin = require('../lib/Tilepin.ProjectConfig.js');
require('../lib/Tilepin.ProjectConfig');
require('../lib/Tilepin.MapProvider');

var Mercator = new (require('sphericalmercator'));
var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

var projectDir = Path.join(__dirname, 'projects/04-simple-shp-project');
var projectFile = Path.join(projectDir, 'project.mml');

describe('Tilepin.MapProvider', function() {
    it('should be able to load a project configuration', //
    withRenderer(function(renderer) {
        var width = 1256;
        var height = 1256;
        var zoom = 5;
        var format = 'png';
        var bbox = Tilepin.MapProvider.getBoundingBox({
            minX : -6.40625,
            minY : 10.811521,
            maxX : 55.15625,
            maxY : 70.7289,
        });
        // -----
        var bbox = Tilepin.MapProvider.getBoundingBox({
            minX : -10.259765625,
            minY : 35.24561909420681,
            maxX : 50.51171875,
            maxY : 82.23551372557404,
        });
        var zoom = 15;
        var dim = Math.round(256);
        var size = {
            width : dim,
            height : dim,
        }
        return renderer.buildVtile({
            bbox : bbox,
            size : size
        })
        // ------

        // Build a vector tile
        // return renderer.buildVtile({
        // bbox : bbox,
        // zoom : zoom
        // })
        // Render vector tile
        .then(function(tile) {
            return Tilepin.MapProvider.serializeVtile(tile);
        })
        // Parse vector tile with new size
        .then(function(buf) {
            return Tilepin.MapProvider.parseVtile(buf, size);
        })
        //
        .then(function(tile) {
            // var path = Path.join(projectDir, 'map.pbf');
            // FS.writeFileSync(path, tile.getData());
            var k = 1;
            return renderer.renderVtile({
                bbox : bbox,
                format : format,
                width : size.width * k,
                height : size.height * k
            }, tile);
        })
        // 
        .then(function(img) {
            var str = img.data.toString('hex');
            var path = Path.join(projectDir, 'map.png');
            // FS.writeFileSync(path, img.data);
            var control = FS.readFileSync(path).toString('hex');
            expect(str).to.eql(control);
        })
        // Close the renderer
        .then(function(tile) {
            renderer.close();
        }, function(err) {
            renderer.close();
            throw err;
        });
    }));

    it('should be able to load a project configuration', // 
    withRenderer(function(renderer) {
        var format = 'pdf'
        var file = './tmp/map.' + format;
        var bbox = Tilepin.MapProvider.getBoundingBox({
            minX : -10.259765625,
            minY : 35.24561909420681,
            maxX : 74.51171875,
            maxY : 72.23551372557404,
        });
        var zoom = 5;
        var size = Tilepin.MapProvider.getMapSizeFromBoundingBox(zoom, bbox);
        var ratio = size.height / size.width;
        var height = 256;
        var width = Math.round(height / ratio);
        return renderer.renderMapToFile({
            file : file,
            format : format,
            bbox : bbox,
            size : {
                width : width,
                height : height
            }
        }).then(function() {
            console.log('DONE!')
        })
    }));

    function withRenderer(callback) {
        return function(done) {
            return Tilepin.P().then(function() {
                var project = new Tilepin.ProjectConfig({
                    projectDir : projectDir,
                    projectFile : projectFile
                });
                expect(project).not.to.be(null);
                var params = {};
                return Tilepin.P.fin(project.open().then(function() {
                    var mapnikAdapter = project //
                    .getAdapter(Tilepin.ConfigAdapter.MapnikAdapter);
                    return mapnikAdapter.prepareMapnikConfig(params) // 
                    .then(function(options) {
                        var renderer = new Tilepin.MapProvider({
                            xml : options.xml,
                            base : projectDir
                        });
                        return callback(renderer);
                    });
                }), function() {
                    return project.close();
                });
            }).then(done, function(err) {
                done(err);
            }).done();
        }
    }
})
