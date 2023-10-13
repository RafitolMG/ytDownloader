import  configparser

def load_output_folder():
    config= configparser.ConfigParser()
    try:
        config.read('config.ini')
        output_folder = config.get('Settings','OutputFolder')
        return output_folder
    except (configparser.NoSectionError, configparser.NoOptionError):
        return ''

def save_output_folder(output_folder):
    config = configparser.ConfigParser()
    config['Settings']={'OutputFolder':output_folder}
    with open('config.ini','w') as configfile:
        config.write(configfile)