var
async = require('async'),
fs = require('fs'),
path = require('path'),
request = require('request'),
cleanCss = require('clean-css'),
uglifyJs = require('uglify-js');

exports.middleware = function(options) {
  var bundles = {};

  var emit = function(name) {
    // emit bundled file
    return [
      name
    ];
  };

  if (options.env === 'development'){
    emit = function(name) {
      // emit each file in bundle
      return bundles[name].files.map(function(file) {
        return file.name;
      });
    };
  }

  if (options.attachTo){
    options.attachTo.bundles = {};
    options.attachTo.bundles.emit = emit;
  }


  options.hooks = options.hooks ? options.hooks : {};
  Object.keys(options.bundles).forEach(function(name) {
    var outputPath = path.join(options.src, name);
    var fileList = [];

    options.bundles[name].forEach(function(pattern) {
      var filePattern = path.basename(path.join(options.src, pattern));
      var dirFiles;

      if (filePattern.indexOf("*") > -1) {
        dirFiles = fs.readdirSync(path.dirname(path.join(options.src, pattern)));

        if (filePattern.length > 1) {
          dirFiles = dirFiles.filter(function(filename) {
            return path.basename(filename).match(new RegExp(filePattern));
          });
        }
      }

      if (dirFiles) {
        fileList = fileList.concat(dirFiles.map(function(file) {
          return path.join(path.dirname(pattern), file);
        }));
      } else {
        fileList.push(pattern);
      }
    });

    if (fileList.length == 0) fileList = options.bundles[name];

    var files = fileList.map(function(filename) {
      var file = {
        name: filename
      };
      if (/^https?\:/.test(filename)){
        file.path = filename;
        file.getModifiedTime = false;
        file.read = function(done){
          var request = require('request');

          request.get(this.path, {}, function (error, response, body) {
            if (response.statusCode === 200) {
              if (error) {
                return done(error);
              };
              done(null, body);
            }
            else {
              return done(error);
            }
          });
        };
      }
      else {
        file.path = path.join(options.src, filename);
        file.getModifiedTime = function(){
          return fs.statSync(this.path).mtime;
        }
        file.read = function(done){
          fs.readFile(this.path, {
            encoding: 'utf8'
          }, function(err, data){
            done(err, data);
          });
        };
      }

      return file;
    });
    bundles[name] = {
      name: name,
      path: outputPath,
      files: files
    }
  });

  // Checks if any file under @bundle has changed
  function check(bundle, done) {
    async.some(bundle.files, function(file, done) {
      var bundle = bundles[file.name]
      if(bundle) {
        // @file is another bundle, check it
        check(bundle, function(err, changed) {
          done(changed)
        })
        return
      }

      // Compare mtime
      if (file.getModifiedTime){
        file.ttime = file.getModifiedTime();
        done(!file.mtime || file.ttime - file.mtime);
      }
      else{
        done(null, false);
      }
    }, function(changed) {
      done(null, changed)
    });
  }

  function build(bundle, done) {
    // check bundle for change
    check(bundle, function(err, changed) {

      if(err) {
        done(err)
        return
      }

      if(!changed && fs.existsSync(bundle.path)) {
        // @bundle hasn't changed, rebuild unnecessary
        done()
        return
      }

      // merge all file data
      async.map(bundle.files, function(file, done) {
        var bundle = bundles[file.name]
        if(bundle) {
          // @file is a bundle, build it
          build(bundle, function(err, data) {
            if(err) {
              done(err);
              return;
            }

            // read file, add to memo
            fs.readFile(bundle.path, {
              encoding: 'utf8'
            }, function(err, data) {
              if(err) {
                done(err);
                return;
              }
              done(null, data);
            })
          });
          return;
        }

        file.read(function(err, data) {
          if (err) {
            done(err);
            return;
          }

          var ext = path.extname(file.name)

          var hook = options.hasOwnProperty("hooks") ? options.hooks[ext] : null
          if(hook) {
            // hook defined, use it
            hook(file, data, function(err, data) {
              if (err) {
                console.log(err);
                done(err);
                return;
              }
              done(null, data);
            });
            return;
          }

          done(null, data)
        });
      }, function(err, results) {
        if(err) {
          done(err)
          return
        }

        // update each file's mtime
        bundle.files.forEach(function(file) {
          file.mtime = file.ttime
        })

        // save bundle
        save(bundle.name, results, function(err) {
          if(err) {
            done(err)
            return
          }
          done(null, results)
        })
      })
    })
  }

  function save(name, data, done) {
    switch(path.extname(name)) {
    case '.css':
      // minify css
      data = cleanCss.process(data.join('\n'));
      fs.writeFile(path.join(options.src, name), data, done);
      break;

    case '.html':
      fs.writeFile(path.join(options.src, name), data.join("\n"), done);
      break;

    case '.js':
      // mangle and minify js
      var ast = null;
      data.forEach(function(code) {
        ast = uglifyJs.parse(code, {
          toplevel: ast
        })
      })
      ast.figure_out_scope()
      ast = ast.transform(uglifyJs.Compressor({
        warnings: false
      }))
      ast.figure_out_scope()
      ast.compute_char_frequency()
      ast.mangle_names()
      data = ast.print_to_string({
        comments: /^\/*!/
      });
      fs.writeFile(path.join(options.src, name), data, done);
      break;
    }
  }

  return function(req, res, next) {

    if (!options.attachTo) {
      res.locals.bundles = {};
      res.locals.bundles.emit = emit;
    }

    var bundle = bundles[path.relative('/', req.url)] || bundles[path.relative('/', req.url).replace("\\","/")];

    if(!bundle) {
      // not a bundle, skip it
      next();
      return;
    }

    build(bundle, function(err) {
      next(err);
    })
  }
}
