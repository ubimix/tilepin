var Tilepin = require('../lib/Tilepin.ProjectConfig.js');
require('../lib/Tilepin.P');

var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

describe('Tilepin.ProjectConfig', function() {
    it('should manage specific extensions', suite(function() {
        var projectDir = Path.join(__dirname,
                'projects/01-simple-tilemill-project');
        var config = new Tilepin.ProjectConfig({
            projectDir : projectDir,
        });
        var mapnikConfig;
        return openConfig(config, function() {
            return Tilepin.P()//
            .then(function() {
                // Check that the configuration is able to return a new adapter
                return config.getAdapter(Tilepin.MapnikConfig)//
                .then(function(c) {
                    mapnikConfig = c;
                    expect(mapnikConfig).not.to.eql(undefined);
                    expect(mapnikConfig).not.to.eql(null);
                });
            })//
            .then(function() {
                // The second time the project should return the same adapter
                // instance
                return config.getAdapter(Tilepin.MapnikConfig)//
                .then(function(test) {
                    expect(test).to.be(mapnikConfig);
                });
            })
        });
    }));

    it('should be able to load a project configuration', suite(function() {
        var projectDir = Path.join(__dirname,
                'projects/01-simple-tilemill-project');
        var config = new Tilepin.ProjectConfig({
            projectDir : projectDir,
        });
        expect(config).not.to.be(null);
        return openConfig(config, function(mml) {
            expect(mml).not.to.be(null);
            expect(_.isArray(mml.Layer)).to.be(true);
            expect(mml.Layer.length).to.be(1);
            var datasource = mml.Layer[0].Datasource;
            expect(datasource).not.to.be(null);
            var expectedFile = 'layers/country-shapes-110m/' //
                    + 'd0c530d7-ne_110m_admin_0_countries.shp';
            expectedFile = Path.join(projectDir, expectedFile);
            expect(datasource.file).to.eql(expectedFile);

            var test = config.getProjectConfig();
            expect(test).to.be(mml);
        })
    }));

    it('should be able to load configurations with dynamic styles',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/02-project-with-jsstyles');
                var config = new Tilepin.ProjectConfig({
                    projectDir : projectDir,
                });
                return openConfig(config, function(mml) {
                    var stylesheets = mml.Stylesheet;
                    expect(stylesheets).not.to.be(null);
                    expect(stylesheets.length).to.be(1);
                    var path = Path.join(projectDir, 'expected.style');
                    var expectedStyle = FS.readFileSync(path, 'UTF-8');
                    var a = JSON.stringify(stylesheets[0].data, null, 2);
                    var b = JSON.stringify(expectedStyle, null, 2);
                    expect(a).to.eql(b);
                });
            }));

    it('should be able to generate a Mapnik XML file', suite(function() {
        var projectDir = Path.join(__dirname,
                'projects/02-project-with-jsstyles');
        var config = new Tilepin.ProjectConfig({
            projectDir : projectDir,
        });
        var params = {};
        return openConfig(config, function() {
            return config.prepareProjectConfig(params) //
            .then(
                    function(options) {
                        expect(options).not.to.be(null);
                        expect(options.xml).not.to.be(null);
                        expect(options.config).not.to.be(null);
                        var str = '<?xml version="1.0" encoding="utf-8"?>';
                        expect(options.xml.indexOf(str) == 0).to.be(true);

                        var path = Path.join(projectDir, '' + //
                        'layers/country-shapes-110m/' + //
                        'd0c530d7-ne_110m_admin_0_countries.shp');
                        var str = '<Parameter name="file"><![CDATA[' + path
                                + ']]></Parameter>'
                        expect(options.xml.indexOf(str) > 0).to.be(true);
                    });
        });
    }));

    it('should be able to generate unique identifiers for parameters',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/03-project-with-parameters');
                var config = new Tilepin.ProjectConfig({
                    projectDir : projectDir,
                });
                return openConfig(config, function() {
                    var params = {
                        'q' : 'b'
                    };
                    var key = config.getCacheKey(params);
                    var str = Tilepin.ProjectConfig.toKey('B');
                    expect(key).to.eql(str);
                })
            }));

    it('should be able to handle datalayers using provided methods',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/03-project-with-parameters');
                var handled = false;
                var config = new Tilepin.ProjectConfig({
                    projectDir : projectDir,
                    handleDatalayer : function(args) {
                        handled = true;
                    }
                });
                return openConfig(config, function() {
                    var params = {
                        'q' : 'hello, world!'
                    };
                    var value = params.q.toUpperCase();
                    return config.prepareProjectConfig(params).then(
                            function(options) {
                                expect(handled).to.eql(true);
                                expect(options.config.Layer[0].Datasource.q).to
                                        .eql(value);
                                // A new parameter added to the datalayer by a
                                // config handler method
                                var str = '<Parameter name="q">' + '<![CDATA['
                                        + value + ']]>' + '</Parameter>';
                                expect(options.xml.indexOf(str) > 0).to
                                        .be(true);
                            });
                })
            }));

    it('should be able to read separate configurations for data and styles',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/05-project-splitted-config');
                var handled = false;
                var config = new Tilepin.ProjectConfig({
                    projectDir : projectDir,
                    handleDatalayer : function(args) {
                        handled = true;
                    }
                });
                return openConfig(config, function() {
                    var params = {
                        'q' : 'hello, world!'
                    };
                    var value = params.q.toUpperCase();
                    return config.prepareProjectConfig(params).then(
                            function(options) {
                                expect(handled).to.eql(true);
                                expect(options.config.Layer[0].Datasource.q).to
                                        .eql(value);
                                // A new parameter added to the datalayer by a
                                // project handler method
                                var str = '<Parameter name="q">' + '<![CDATA['
                                        + value + ']]>' + '</Parameter>';
                                expect(options.xml.indexOf(str) > 0).to
                                        .be(true);

                                expect(options.config.Stylesheet).not.to
                                        .eql(null);
                                expect(options.config.Stylesheet.length).to
                                        .eql(1);
                                expect(options.config.Stylesheet[0].id).to
                                        .eql('style.mss');
                                var str = options.config.Stylesheet[0].data;
                                var control = FS.readFileSync(Path.join(
                                        projectDir, 'style.mss'), 'UTF-8');
                                expect(str).to.eql(control);
                            });
                })
            }));
})

function openConfig(config, callback) {
    return Tilepin.P.fin(config.open().then(callback), function() {
        return config.close();
    });
}
function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done(err);
        }).done();
    }
}