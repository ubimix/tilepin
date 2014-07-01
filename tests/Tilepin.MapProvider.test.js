var Tilepin = require('../lib/Tilepin.Project.js');
require('../lib/Tilepin.P');
require('../lib/Tilepin.Project');
require('../lib/Tilepin.MapProvider');

var Mercator = new (require('sphericalmercator'));
var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

describe('Tilepin.MapProvider', function() {
    it('should be able to load a project configuration',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/04-simple-shp-project');
                var projectFile = Path.join(projectDir, 'project.mml');
                var project = new Tilepin.Project({
                    projectDir : projectDir,
                    projectFile : projectFile
                });
                expect(project).not.to.be(null);
                var params = {
                    'q' : 'hello, world!'
                };
                return withProject(project, params, function(options) {

                    var width = 256;
                    var height = 256;
                    var format = 'png';

                    var bbox = Tilepin.MapProvider.getBoundingBox({
                        west : -6.40625,
                        north : 70.7289,
                        east : 55.15625,
                        south : 10.811521,
                    });
                    var zoom = 5;
                    var renderer = new Tilepin.MapProvider({
                        xml : options.xml,
                        base : projectDir
                    });

                    // Build a vector tile
                    return renderer.buildVtile({
                        bbox : bbox,
                        zoom : zoom
                    })
                    // Render vector tile
                    .then(function(tile) {
                        // var path = Path.join(projectDir, 'map.pbf');
                        // FS.writeFileSync(path, tile.getData());
                        return renderer.renderVtile({
                            bbox : bbox,
                            width : width,
                            height : height,
                            format : format
                        }, tile);
                    }).then(function(img) {
                        var str = img.data.toString('hex');
                        var path = Path.join(projectDir, 'map.png');
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
                })
            }));

})

function withProject(project, params, callback) {
    return Tilepin.P.fin(project.open().then(function(mml) {
        return project.prepareProjectConfig(params).then(callback);
    }), function() {
        return project.close();
    });
}

function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done(err);
        }).done();
    }
}