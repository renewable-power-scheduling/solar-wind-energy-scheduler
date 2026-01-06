import pandas as pd

def parse_enercast_csv(file_path):
    """
    Reads Enercast CSV file and converts it into
    a matrix-like Pandas DataFrame.
    """
    df = pd.read_csv(
        file_path,
        skiprows=6,
        header=None
    )
    return df


def get_value(df, row, col):
    """
    Returns a specific value from the matrix
    using row and column index (0-based).
    """
    return df.iloc[row, col]


def get_shape(df):
    """
    Returns number of rows and columns.
    """
    return df.shape
